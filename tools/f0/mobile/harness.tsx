import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from '@inertiajs/react';
import { Button, MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import '@mantine/core/styles.css';

// Direct source imports: these components and the hook are NOT copied or mocked.
import { AgentFormModal } from '../../../app/frontend/shared/resources/agents/AgentFormModal';
import { TaskCardUI } from '../../../app/frontend/pages/Projects/Board/TaskCardUI';
import { RunStepTimeline } from '../../../app/frontend/pages/Projects/Board/RunStepTimeline';
import { SessionTreeNav, type Selection } from '../../../app/frontend/pages/Projects/Workflows/SessionTreeNav';
import { useInertiaCableStream } from '../../../app/frontend/shared/lib/hooks/useInertiaCableStream';
import type BoardTask from '../../../app/frontend/types/generated/BoardTask';
import './harness.css';

const task: BoardTask = {
  id: 1, number: 1, title: 'Synthetic mobile task', description: null,
  taskType: 'story', priority: null, assigneeId: null, boardColumnId: 1,
  position: 1, parentTaskId: null, tags: ['synthetic'], createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z', assigneeName: null, archived: false,
  commentsCount: 0, childrenCount: 0, assetsCount: 0, recentWorkflowRuns: [],
  pendingGates: [], ciGates: [],
};
const sessions = [
  { id: 1, name: 'Implementation', position: 1, allowNonInteractive: false, bmadEnabled: false,
    dependsOnStepIds: [], subSteps: [{ id: 11, name: 'Inspect', position: 1 }] },
  { id: 2, name: 'Review', position: 2, allowNonInteractive: false, bmadEnabled: false,
    dependsOnStepIds: [1], subSteps: [{ id: 21, name: 'Verify', position: 1 }] },
];
const noop = () => {};

function Harness() {
  const [opened, setOpened] = useState(false);
  const [saved, setSaved] = useState(false);
  const [state, setState] = useState('running');
  const [reloads, setReloads] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);

  // Explicit seam ONLY in the harness. Playwright supplies the HTTP responses.
  // No fake persistence, command deduplication or workflow engine is implemented.
  router.post = ((_url, data, options) => {
    fetch('/__f0/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data) }).then(response => {
      if (!response.ok) throw new Error('Synthetic transport failure');
      setSaved(true);
      options?.onSuccess?.({} as never);
    }).catch(() => options?.onError?.({ title: 'Synthetic acknowledgement lost; retry possible' }));
  }) as typeof router.post;
  router.reload = (() => {
    fetch('/__f0/snapshot').then(response => response.json()).then(snapshot => {
      setState(snapshot.state);
      setReloads(value => value + 1);
    });
  }) as typeof router.reload;

  useInertiaCableStream('synthetic-f0-stream', { only: ['run'], debounceMs: 50 });

  return <main>
    <h1>F0 Aixle components</h1>
    <p role="note">PARTIAL PROOF — synthetic transport and task. No authenticated product, account profile or backend execution.</p>
    <Button onClick={() => setOpened(true)}>Open real agent form</Button>
    <AgentFormModal opened={opened} onClose={() => setOpened(false)} basePath="/company/projects/1/agents" />
    <p data-testid="agent-result">{saved ? 'Synthetic agent acknowledgement received' : 'No acknowledgement'}</p>
    <section aria-label="Task fixture"><h2>Real task card / synthetic data</h2>
      <TaskCardUI task={{ ...task, recentWorkflowRuns: [{ id: 1, state, createdAt: task.createdAt }] }} />
    </section>
    <section aria-label="Run steps"><h2>Real step timeline / synthetic state</h2>
      <RunStepTimeline steps={['Inspect', 'Implement', 'Verify', 'Report'].map((name, index) => ({
        name, state: state === 'completed' ? 'done' : index === 0 ? 'running' : 'waiting', durationSeconds: null,
      }))} />
    </section>
    <section aria-label="Dependencies"><h2>Real dependency tree / synthetic topology</h2>
      <SessionTreeNav steps={sessions} selection={selection} readOnly
        onSelectSession={id => setSelection({ mode: 'session', sessionId: id })}
        onSelectStep={(sessionId, stepId) => setSelection({ mode: 'step', sessionId, stepId })}
        onDeleteSession={noop} onDeleteStep={noop} onAddSession={noop} onAddStep={noop}
        onReorderSessions={noop} onReorderSteps={noop} />
      <output data-testid="selection">{selection ? `${selection.mode}:${selection.sessionId}` : 'None selected'}</output>
    </section>
    <output data-testid="reconnect">Reloads: {reloads}; snapshot: {state}</output>
  </main>;
}

createRoot(document.getElementById('root')!).render(
  <MantineProvider><ModalsProvider><Harness /></ModalsProvider></MantineProvider>,
);
