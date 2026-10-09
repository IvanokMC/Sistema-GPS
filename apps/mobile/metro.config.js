// Metro no sigue enlaces fuera de la carpeta de la app por defecto.
// En un monorepo con workspaces de npm, @gps/shared vive en la raiz y sus
// dependencias estan hoisted, asi que hay que decirle ambas cosas a Metro.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Vigilar todo el monorepo para recompilar cuando cambie @gps/shared.
config.watchFolders = [workspaceRoot];

// 2. Resolver modulos primero en la app y despues en la raiz (paquetes hoisted).
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// 3. Sin esto, una dependencia duplicada (p. ej. dos copias de React) rompe
//    los hooks en tiempo de ejecucion con un error dificil de diagnosticar.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
