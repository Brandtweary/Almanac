import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';

/** Distinguish admission failures from errors after the user's message exists. */
export async function sendWithAdmission(
 session: Pick<Agent, 'prompt' | 'subscribe'>,
 message: AgentMessage,
 onAccepted: () => void,
 onRejected?: (error: unknown) => void,
): Promise<void> {
 let accepted = false;
 const accept = () => { if (!accepted) { accepted = true; onAccepted(); } };
 const unsubscribe = session.subscribe?.(event => {
  if (event.type === 'message_start' && event.message === message) accept();
 });
 try { await session.prompt(message); accept(); }
 catch (error) { if (!accepted) onRejected?.(error); throw error; }
 finally { unsubscribe?.(); }
}
