const path = require('node:path');
const { tmpdir } = require('node:os');
const { BRIDGE_ENV_PORT_KEY, BRIDGE_ENV_AUTH_TOKEN_KEY, BRIDGE_BOOTSTRAP_AUTH_ENV_KEY } = require('../../../shared/bridge-contract.cjs');

const CONNECTION_ROOT_DIR = path.join(tmpdir(), 'pi-ide-bridge');
const CONNECTION_DIR = path.join(CONNECTION_ROOT_DIR, 'ide');

async function writeConnectionFile(fs, processPid, port, authToken) {
  await fs.mkdir(CONNECTION_ROOT_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(CONNECTION_ROOT_DIR, 0o700);
  await fs.mkdir(CONNECTION_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(CONNECTION_DIR, 0o700);

  const connectionFile = path.join(CONNECTION_DIR, `pi-ide-bridge-server-${processPid}-${port}.json`);
  await fs.writeFile(connectionFile, JSON.stringify({ port, authToken }, null, 2), { mode: 0o600 });
  return connectionFile;
}

function publishEnv(context, port, authToken, bootstrapAuthToken) {
  context.environmentVariableCollection.replace(BRIDGE_ENV_PORT_KEY, String(port));
  context.environmentVariableCollection.replace(BRIDGE_ENV_AUTH_TOKEN_KEY, authToken);
  context.environmentVariableCollection.replace(BRIDGE_BOOTSTRAP_AUTH_ENV_KEY, bootstrapAuthToken);
}

function clearEnv(context) {
  context.environmentVariableCollection.delete?.(BRIDGE_ENV_PORT_KEY);
  context.environmentVariableCollection.delete?.(BRIDGE_ENV_AUTH_TOKEN_KEY);
  context.environmentVariableCollection.delete?.(BRIDGE_BOOTSTRAP_AUTH_ENV_KEY);
}

async function removeConnectionFile(fs, connectionFile) {
  if (!connectionFile) return;
  await fs.unlink(connectionFile).catch((error) => {
    console.warn(`Pi IDE Bridge: failed to remove connection file ${connectionFile}: ${String(error?.message || error)}`);
  });
}

module.exports = {
  writeConnectionFile,
  publishEnv,
  clearEnv,
  removeConnectionFile,
};
