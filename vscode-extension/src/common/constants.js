const { BRIDGE_HOST, BRIDGE_BOOTSTRAP_PORT } = require('../../../shared/bridge-contract.cjs');
const AFTER_SCHEME = 'pi-ide-bridge-after';
const DIFF_VISIBLE_CONTEXT = 'pi.diff.isVisible';
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const BOOTSTRAP_PORT = BRIDGE_BOOTSTRAP_PORT;

module.exports = {
  BRIDGE_HOST,
  AFTER_SCHEME,
  DIFF_VISIBLE_CONTEXT,
  MAX_REQUEST_BODY_BYTES,
  BOOTSTRAP_PORT,
};
