export interface SessionRecord {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  version: string;
  model: string;
  cwd?: string;
}
