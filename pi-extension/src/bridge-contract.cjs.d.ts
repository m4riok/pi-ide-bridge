declare const contract: {
  BRIDGE_HOST: string;
  BRIDGE_BOOTSTRAP_PORT: number;
  BRIDGE_ENV_PORT_KEY: string;
  BRIDGE_ENV_AUTH_TOKEN_KEY: string;
  BRIDGE_BOOTSTRAP_AUTH_ENV_KEY: string;
  BRIDGE_OPEN_DIFF_PATH: string;
  BRIDGE_CLOSE_DIFF_PATH: string;
  BRIDGE_HEALTH_PATH: string;
  BRIDGE_CONTEXT_STREAM_PATH: string;
  BRIDGE_DIAGNOSTICS_PATH: string;
  BRIDGE_BOOTSTRAP_INFO_PATH: string;
};

export = contract;
