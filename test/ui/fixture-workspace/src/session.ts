export interface Session {
  id: string;
  userId: string;
}

export function createSession(userId: string): Session {
  return { id: `s-${userId}`, userId };
}
