export type ApprovalMode = 'ask' | 'auto';
export type ApprovalDecision = 'approved' | 'approved_auto' | 'rejected';
export type BridgeCloseDecision = 'approved' | 'rejected' | 'closed_by_pi';

export type RejectedChange = {
  filePath: string;
  beforeText: string;
  afterText: string;
  rejectedAt: number;
};

export type BridgeConnection = {
  port: number;
  authToken: string;
};
