import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONFIG } from './config';
import { createReportFilter, type Position, type ReportDecision } from '@gps/shared';

export type LinkStatus = 'idle' | 'connecting' | 'online' | 'offline';

/** Contadores para entender, desde la propia app, que pasa con cada lectura. */
export interface Diagnostics {
  recibidas: number;
  enviadas: number;
  descartadas: Record<'antigua' | 'duplicada' | 'imprecisa' | 'sin-cambio', number>;
  errores: number;
  ultimoMotivo: string | null;
  ultimoEnvio: number | null;
}

export interface UplinkSnapshot {
  status: LinkStatus;
  /** Posiciones esperando a que vuelva la red. */
  queued: number;
  /** Total aceptado por el backend desde que arranco la app. */
  sent: number;
  lastPosition: Position | null;
  lastError: string | null;
  diag: Diagnostics;
}

type Listener = (snapshot: UplinkSnapshot) => void;

const QUEUE_KEY = 'gps.offline.queue.v1';

const log = (...args: unknown[]) => console.log('[gps]', ...args);

/**
 * Canal de envio hacia el backend, sobre HTTP.
 *
 * **Por que HTTP y no WebSocket.** El rastreo en segundo plano lo gobierna el
 * sistema operativo: despierta la tarea, le entrega una lectura y puede
 * destruir su contexto de inmediato. Un WebSocket necesita completar un
 * handshake y mantenerse vivo; una peticion HTTP se resuelve en una sola
 * operacion que la tarea puede esperar antes de terminar.
 *
 * Garantias:
 *  - Filtro de precision y de ruido (createReportFilter): solo viaja lo que
 *    aporta a la ruta, mas un latido periodico.
 *  - Cola persistente en disco: sin cobertura, las lecturas se guardan y se
 *    envian en lote al volver la red.
 *  - Envios serializados: si el sistema invoca la tarea dos veces seguidas,
 *    la segunda espera a la primera y la cola no se envia dos veces.
 */
class Uplink {
  private listeners = new Set<Listener>();
  private queue: Position[] = [];
  private queueLoaded = false;
  private activo = false;
  private filtro = createReportFilter(CONFIG.report);
  /** Cadena de promesas que serializa los envios. */
  private candado: Promise<unknown> = Promise.resolve();

  private snapshot: UplinkSnapshot = {
    status: 'idle',
    queued: 0,
    sent: 0,
    lastPosition: null,
    lastError: null,
    diag: {
      recibidas: 0,
      enviadas: 0,
      descartadas: { antigua: 0, duplicada: 0, imprecisa: 0, 'sin-cambio': 0 },
      errores: 0,
      ultimoMotivo: null,
      ultimoEnvio: null,
    },
  };

  /* ----------------------------- Suscripcion ----------------------------- */

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<UplinkSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, queued: this.queue.length };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  getSnapshot(): UplinkSnapshot {
    return this.snapshot;
  }

  private exclusivo<T>(fn: () => Promise<T>): Promise<T> {
    const siguiente = this.candado.then(fn, fn);
    this.candado = siguiente.catch(() => undefined);
    return siguiente;
  }

  /* -------------------------------- Ciclo -------------------------------- */

  async connect(): Promise<void> {
    if (!this.activo) {
      this.activo = true;
      // Al reanudar, la primera lectura se envia sin esperar al latido.
      this.filtro.reset();
    }
    await this.loadQueue();
    this.emit({ status: this.queue.length > 0 ? 'offline' : 'connecting' });
    await this.exclusivo(() => this.flushQueue());
  }

  disconnect(): void {
    this.activo = false;
    this.emit({ status: 'idle' });
  }

  /* ------------------------------ Posiciones ----------------------------- */

  /** Punto de entrada unico para una lectura, venga de la interfaz o de la tarea. */
  push(position: Position): Promise<boolean> {
    return this.exclusivo(() => this.procesar(position));
  }

  private async procesar(position: Position): Promise<boolean> {
    const diag = { ...this.snapshot.diag, recibidas: this.snapshot.diag.recibidas + 1 };
    const decision: ReportDecision = this.filtro.decide(position);

    if (!decision.send) {
      diag.descartadas = { ...diag.descartadas, [decision.reason]: diag.descartadas[decision.reason] + 1 };
      diag.ultimoMotivo = `descartada: ${decision.reason}`;
      // La pantalla muestra la lectura aunque no viaje, salvo que sea vieja.
      const obsoleta = decision.reason === 'antigua' || decision.reason === 'duplicada';
      this.emit({ diag, ...(obsoleta ? {} : { lastPosition: position }) });
      return false;
    }

    diag.ultimoMotivo = `enviada: ${decision.reason}`;
    this.emit({ diag, lastPosition: decision.position });

    await this.loadQueue();
    const pendientes = [...this.queue, decision.position];
    const ok = await this.enviar(pendientes);

    if (ok) {
      this.queue = [];
      await this.persistQueue();
      log(`enviada (${decision.reason}), lote de ${pendientes.length}`);
      this.emit({
        status: 'online',
        sent: this.snapshot.sent + pendientes.length,
        lastError: null,
        diag: { ...this.snapshot.diag, enviadas: this.snapshot.diag.enviadas + pendientes.length, ultimoEnvio: Date.now() },
      });
      return true;
    }

    this.queue = pendientes.slice(-CONFIG.offlineQueueLimit);
    await this.persistQueue();
    log(`sin red, ${this.queue.length} en cola`);
    this.emit({ status: 'offline' });
    return false;
  }

  /** Envia un lote. Devuelve false si no se pudo entregar. */
  private async enviar(positions: Position[]): Promise<boolean> {
    if (positions.length === 0) return true;

    // Sin tiempo limite, una peticion colgada bloquearia todos los envios
    // siguientes, que esperan su turno en el candado.
    const abort = new AbortController();
    const reloj = setTimeout(() => abort.abort(), CONFIG.requestTimeoutMs);

    try {
      const respuesta = await fetch(`${CONFIG.apiUrl}/positions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${CONFIG.authToken}`,
        },
        body: JSON.stringify({ positions }),
        signal: abort.signal,
      });

      if (!respuesta.ok) {
        const texto = `El servidor respondio ${respuesta.status}`;
        log(texto);
        this.emit({ lastError: texto, diag: { ...this.snapshot.diag, errores: this.snapshot.diag.errores + 1 } });
        return false;
      }
      return true;
    } catch (error) {
      const texto = abort.signal.aborted
        ? 'Tiempo de espera agotado'
        : error instanceof Error
          ? error.message
          : 'Fallo de red';
      log('error de envio:', texto);
      this.emit({ lastError: texto, diag: { ...this.snapshot.diag, errores: this.snapshot.diag.errores + 1 } });
      return false;
    } finally {
      clearTimeout(reloj);
    }
  }

  /* --------------------------- Cola persistente -------------------------- */

  private async loadQueue(): Promise<void> {
    if (this.queueLoaded) return;
    this.queueLoaded = true;
    try {
      const raw = await AsyncStorage.getItem(QUEUE_KEY);
      if (raw) this.queue = JSON.parse(raw) as Position[];
    } catch {
      this.queue = [];
    }
    this.emit({});
  }

  private async persistQueue(): Promise<void> {
    try {
      if (this.queue.length === 0) await AsyncStorage.removeItem(QUEUE_KEY);
      else await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue));
    } catch {
      // Sin espacio en disco: preferimos perder historial antes que crashear.
    }
  }

  /** Intenta vaciar lo acumulado, en lotes. */
  private async flushQueue(): Promise<void> {
    await this.loadQueue();
    if (this.queue.length === 0) {
      if (this.activo) this.emit({ status: 'online' });
      return;
    }

    const LOTE = 100;
    while (this.queue.length > 0) {
      const chunk = this.queue.slice(0, LOTE);
      if (!(await this.enviar(chunk))) {
        this.emit({ status: 'offline' });
        return;
      }
      this.queue = this.queue.slice(chunk.length);
      this.emit({ sent: this.snapshot.sent + chunk.length });
    }

    await this.persistQueue();
    this.emit({ status: 'online', lastError: null });
  }

  /**
   * Fin del rastreo: descarta lo pendiente y pide al servidor que borre todo
   * lo de este celular, para que desaparezca del mapa en el acto. Devuelve
   * false si no hubo red; en ese caso el servidor lo borra igual al vencer
   * la retencion.
   */
  borrarDatos(deviceId: string): Promise<boolean> {
    return this.exclusivo(async () => {
      this.queue = [];
      await this.persistQueue();
      this.filtro.reset();
      this.emit({ lastPosition: null });

      const abort = new AbortController();
      const reloj = setTimeout(() => abort.abort(), CONFIG.requestTimeoutMs);
      try {
        const r = await fetch(`${CONFIG.apiUrl}/devices/${encodeURIComponent(deviceId)}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${CONFIG.authToken}` },
          signal: abort.signal,
        });
        log(`datos borrados en el servidor: ${r.status}`);
        return r.ok;
      } catch (error) {
        log('no se pudo pedir el borrado:', error instanceof Error ? error.message : error);
        return false;
      } finally {
        clearTimeout(reloj);
      }
    });
  }

  async clearQueue(): Promise<void> {
    this.queue = [];
    this.emit({});
    await AsyncStorage.removeItem(QUEUE_KEY);
  }
}

export const uplink = new Uplink();
