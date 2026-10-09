import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import { CONFIG } from './src/config';
import { uplink, type UplinkSnapshot } from './src/uplink';
import { identidad, renombrar, type Identidad } from './src/identity';
import {
  isLowPowerMode,
  isTracking,
  requestPermissions,
  startTracking,
  stopTracking,
} from './src/tracking';
import { formatSpeed } from '@gps/shared';

const STATUS_TEXT = {
  idle: 'Detenido',
  connecting: 'Conectando…',
  online: 'En línea',
  offline: 'Sin conexión',
} as const;

const STATUS_COLOR = {
  idle: '#64748b',
  connecting: '#f59e0b',
  online: '#22c55e',
  offline: '#ef4444',
} as const;

export default function App() {
  const [link, setLink] = useState<UplinkSnapshot>(uplink.getSnapshot());
  const [tracking, setTracking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Pulsa "Iniciar rastreo" para comenzar.');
  const [ahorro, setAhorro] = useState(false);
  const [yo, setYo] = useState<Identidad | null>(null);
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState('');
  const [ahora, setAhora] = useState(Date.now());

  // Mientras se rastrea desde la app abierta, evitamos que la pantalla se
  // apague durante una demo. El segundo plano no depende de esto.
  useKeepAwake();

  useEffect(() => uplink.subscribe(setLink), []);
  useEffect(() => {
    void identidad().then(setYo);
  }, []);

  const guardarNombre = async () => {
    setYo(await renombrar(borrador));
    setEditando(false);
  };

  // Al abrir la app, puede que el servicio siguiera corriendo de una sesion
  // previa. Se vuelve a registrar en vez de solo reconectar: tras actualizar
  // la app el registro anterior puede estar vivo de nombre pero sin entregar
  // lecturas.
  useEffect(() => {
    void (async () => {
      const active = await isTracking();
      setTracking(active);
      if (active) {
        await startTracking();
        setMessage('El rastreo seguía activo; se reanudó.');
      }
    })();
  }, []);

  // El ahorro de energia se puede activar en cualquier momento: se revisa al
  // volver a la app y cada 15 s.
  useEffect(() => {
    const revisar = () => void isLowPowerMode().then(setAhorro);
    revisar();
    const intervalo = setInterval(() => {
      revisar();
      setAhora(Date.now());
    }, 15_000);
    const reloj = setInterval(() => setAhora(Date.now()), 1_000);
    const sub = AppState.addEventListener('change', (estado) => estado === 'active' && revisar());
    return () => {
      clearInterval(intervalo);
      clearInterval(reloj);
      sub.remove();
    };
  }, []);

  const handleToggle = useCallback(async () => {
    setBusy(true);
    try {
      if (tracking) {
        setMessage(await stopTracking());
        setTracking(false);
      } else {
        const permissions = await requestPermissions();
        if (!permissions.foreground) {
          setMessage(permissions.message);
          return;
        }
        const result = await startTracking();
        setTracking(true);
        setMessage(permissions.background ? result : `${result}\n\n${permissions.message}`);
      }
    } catch (error) {
      setMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [tracking]);

  const position = link.lastPosition;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Rastreo GPS</Text>
        {editando ? (
          <View style={styles.nombreFila}>
            <TextInput
              value={borrador}
              onChangeText={setBorrador}
              style={styles.nombreInput}
              maxLength={40}
              autoFocus
              placeholder="Nombre de este celular"
              placeholderTextColor="#64748b"
              onSubmitEditing={() => void guardarNombre()}
              returnKeyType="done"
            />
            <Pressable style={styles.nombreBoton} onPress={() => void guardarNombre()}>
              <Text style={styles.nombreBotonTexto}>Guardar</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => {
              setBorrador(yo?.nombre ?? '');
              setEditando(true);
            }}
          >
            <Text style={styles.subtitle}>
              {yo ? `${yo.nombre} · ${yo.id}` : '…'}  <Text style={styles.editar}>Cambiar nombre</Text>
            </Text>
          </Pressable>
        )}

        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: STATUS_COLOR[link.status] }]} />
          <Text style={styles.statusText}>{STATUS_TEXT[link.status]}</Text>
          {link.queued > 0 && (
            <Text style={styles.queued}>{link.queued} en cola</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Última lectura</Text>
          {position ? (
            <>
              <Row label="Latitud" value={position.lat.toFixed(6)} />
              <Row label="Longitud" value={position.lng.toFixed(6)} />
              <Row
                label="Precisión"
                value={
                  position.accuracy
                    ? `${Math.round(position.accuracy)} m · ${calidad(position.accuracy).texto}`
                    : '—'
                }
                color={position.accuracy ? calidad(position.accuracy).color : undefined}
              />
              <Row label="Velocidad" value={formatSpeed(position.speed)} />
              <Row
                label="Altitud"
                value={position.altitude ? `${Math.round(position.altitude)} m` : '—'}
              />
              <Row label="Hora" value={new Date(position.timestamp).toLocaleTimeString('es-PE')} />
            </>
          ) : (
            <Text style={styles.muted}>Esperando la primera señal del GPS…</Text>
          )}
        </View>

        {ahorro && Platform.OS === 'android' && (
          <View style={styles.warning}>
            <Text style={styles.warningTitle}>Ahorro de energía activado</Text>
            <Text style={styles.warningText}>
              Con el ahorro activo, ColorOS apaga el GPS de las apps en segundo plano a los
              pocos minutos y el rastreo se detiene solo.
            </Text>
            <View style={styles.warningActions}>
              <Pressable
                style={styles.warningButton}
                onPress={() => void Linking.sendIntent('android.settings.BATTERY_SAVER_SETTINGS').catch(() => Linking.openSettings())}
              >
                <Text style={styles.warningButtonText}>Desactivar ahorro</Text>
              </Pressable>
              <Pressable
                style={styles.warningButton}
                onPress={() => void Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(() => Linking.openSettings())}
              >
                <Text style={styles.warningButtonText}>Excluir esta app</Text>
              </Pressable>
            </View>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Envío</Text>
          <Row label="Aceptadas por el servidor" value={String(link.sent)} />
          <Row label="Pendientes sin red" value={String(link.queued)} />
          <Row
            label="Último envío"
            value={link.diag.ultimoEnvio ? `hace ${Math.max(0, Math.round((ahora - link.diag.ultimoEnvio) / 1000))} s` : '—'}
          />
          <Row label="Servidor" value={CONFIG.apiUrl} small />
          {link.lastError && <Text style={styles.error}>{link.lastError}</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Diagnóstico</Text>
          <Row label="Lecturas del GPS" value={String(link.diag.recibidas)} />
          <Row label="Enviadas" value={String(link.diag.enviadas)} />
          <Row label="Omitidas sin movimiento" value={String(link.diag.descartadas['sin-cambio'])} />
          <Row label="Omitidas por imprecisas" value={String(link.diag.descartadas.imprecisa)} />
          <Row
            label="Omitidas viejas o repetidas"
            value={String(link.diag.descartadas.antigua + link.diag.descartadas.duplicada)}
          />
          <Row label="Errores de red" value={String(link.diag.errores)} />
          {link.diag.ultimoMotivo && <Text style={styles.muted}>Última: {link.diag.ultimoMotivo}</Text>}
        </View>

        <Pressable
          onPress={handleToggle}
          disabled={busy}
          style={({ pressed }) => [
            styles.button,
            tracking ? styles.buttonStop : styles.buttonStart,
            (pressed || busy) && styles.buttonPressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>
              {tracking ? 'Detener rastreo' : 'Iniciar rastreo'}
            </Text>
          )}
        </Pressable>

        <Text style={styles.message}>{message}</Text>

        {Platform.OS === 'android' && (
          <Text style={styles.hint}>
            En el Oppo A78 (ColorOS): Ajustes → Batería → Uso de batería en segundo plano →
            elige "Permitir actividad en segundo plano" para esta app, o el sistema la
            congelará al rato de bloquear la pantalla.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

/** Calidad de la precision, en los mismos cortes que usa el filtro de envio. */
function calidad(accuracy: number): { texto: string; color: string } {
  if (accuracy <= 10) return { texto: 'excelente', color: '#4ade80' };
  if (accuracy <= 20) return { texto: 'buena', color: '#a3e635' };
  if (accuracy <= CONFIG.report.maxAccuracyM) return { texto: 'regular', color: '#facc15' };
  return { texto: 'baja, no se envía', color: '#f87171' };
}

function Row({
  label,
  value,
  small,
  color,
}: {
  label: string;
  value: string;
  small?: boolean;
  color?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, small && styles.rowValueSmall, color ? { color } : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 20, paddingTop: 60, gap: 14, maxWidth: 640, width: '100%', alignSelf: 'center' },
  title: { color: '#f1f5f9', fontSize: 28, fontWeight: '700' },
  subtitle: { color: '#64748b', fontSize: 13, marginTop: -8 },
  editar: { color: '#38bdf8' },
  nombreFila: { flexDirection: 'row', gap: 8, marginTop: -4 },
  nombreInput: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 8,
    color: '#f1f5f9',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  nombreBoton: { backgroundColor: '#2563eb', borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center' },
  nombreBotonTexto: { color: '#fff', fontWeight: '600' },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { color: '#e2e8f0', fontSize: 14 },
  queued: {
    marginLeft: 'auto',
    color: '#f59e0b',
    fontSize: 12,
    backgroundColor: 'rgba(245,158,11,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },

  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#334155',
    gap: 6,
  },
  cardTitle: { color: '#94a3b8', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },

  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { color: '#94a3b8', fontSize: 14 },
  rowValue: { color: '#e2e8f0', fontSize: 14, fontVariant: ['tabular-nums'], flexShrink: 1 },
  rowValueSmall: { fontSize: 11, color: '#64748b' },

  muted: { color: '#64748b', fontSize: 14 },
  error: { color: '#fca5a5', fontSize: 12, marginTop: 6 },

  button: { borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 4 },
  buttonStart: { backgroundColor: '#2563eb' },
  buttonStop: { backgroundColor: '#dc2626' },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  warning: {
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderColor: '#f59e0b',
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  warningTitle: { color: '#fbbf24', fontSize: 15, fontWeight: '700' },
  warningText: { color: '#fde68a', fontSize: 13, lineHeight: 19 },
  warningActions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  warningButton: {
    flex: 1,
    backgroundColor: '#f59e0b',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  warningButtonText: { color: '#111827', fontWeight: '700', fontSize: 13 },

  message: { color: '#94a3b8', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  hint: {
    color: '#64748b',
    fontSize: 12,
    lineHeight: 18,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    paddingTop: 12,
  },
});
