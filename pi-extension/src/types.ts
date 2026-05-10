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

export type OpenFile = {
  path: string;
  timestamp: number;
  isActive?: boolean;
  selectedText?: string;
  cursor?: { line: number; character: number };
};

export type EditorContext = {
  openFiles: OpenFile[];
  isTrusted: boolean;
};
