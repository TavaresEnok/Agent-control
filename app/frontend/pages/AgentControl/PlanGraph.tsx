import { Head } from '@inertiajs/react';
import { Badge, Button, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { IconPlayerPlay, IconPlayerPause, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';

import classes from './PlanGraph.module.css';

export interface GraphNode {
  id: number;
  task_key: string;
  title: string;
  scope: string;
  state: 'pending' | 'running' | 'review' | 'integrated' | 'waiting_dependencies' | 'needs_changes' | 'failed' | 'cancelled';
  assigned_role: string;
  risk_class: string;
  position: number;
  attempt_count: number;
  max_attempts: number;
  active_execution_id: number | null;
  approved_commit_sha: string | null;
  depends_on: string[];
  flags: {
    waiting_dependencies: boolean;
    needs_changes: boolean;
    review: boolean;
    integrated: boolean;
    terminal: boolean;
  };
}

export interface GraphEdge {
  id: string;
  source: number;
  source_key: string;
  target: number;
  target_key: string;
  fulfilled: boolean;
}

export interface GraphData {
  plan: {
    id: number;
    plan_key: string;
    title: string;
    objective: string;
    version: number;
    project_id: number;
    state?: string;
    paused?: boolean;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: {
    total_tasks: number;
    pending: number;
    running: number;
    review: number;
    integrated: number;
    waiting_dependencies: number;
    needs_changes: number;
    all_completed: boolean;
    plan_state?: string;
    paused?: boolean;
  };
  projection_timestamp: string;
}

interface PlanGraphProps {
  plan: GraphData['plan'];
  initialGraph: GraphData;
}

export default function PlanGraph({ plan, initialGraph }: PlanGraphProps) {
  const [graph, setGraph] = useState<GraphData>(initialGraph);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null);

  const fetchLatestGraph = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/agent_control/dag_graphs/${plan.id}`);
      if (res.ok) {
        const data = await res.json();
        setGraph(data);
      }
    } catch (err) {
      console.error('Failed to sync DAG graph:', err);
    } finally {
      setLoading(false);
    }
  };

  const executePlanCommand = async (commandType: 'advance_dag' | 'pause_plan' | 'resume_plan' | 'cancel_plan', reason?: string) => {
    setLoading(true);
    setCommandFeedback(null);
    const intentId = `client-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    try {
      const res = await fetch('/api/v1/agent_control/client_commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent_id: intentId,
          command_type: commandType,
          payload: { plan_id: plan.id, reason }
        })
      });

      const data = await res.json();
      if (res.ok) {
        let msg = 'Comando processado com sucesso!';
        if (commandType === 'pause_plan') msg = 'Plano pausado com sucesso!';
        if (commandType === 'resume_plan') msg = 'Plano retomado com sucesso!';
        if (commandType === 'cancel_plan') msg = 'Plano cancelado com sucesso!';
        if (commandType === 'advance_dag') msg = 'DAG avançado com sucesso!';
        setCommandFeedback(data.deduplicated ? `${msg} (Deduplicado)` : msg);
        await fetchLatestGraph();
      } else {
        setCommandFeedback(`Erro: ${data.error || 'Falha ao processar'}`);
      }
    } catch (err) {
      setCommandFeedback('Erro de conexão ao enviar comando operacional');
    } finally {
      setLoading(false);
    }
  };

  const getStateBadgeClass = (state: GraphNode['state']) => {
    switch (state) {
      case 'integrated': return classes.badgeIntegrated;
      case 'running': return classes.badgeRunning;
      case 'review': return classes.badgeReview;
      case 'needs_changes': return classes.badgeNeedsChanges;
      case 'waiting_dependencies': return classes.badgeWaiting;
      default: return classes.badgePending;
    }
  };

  const isPlanPaused = graph.plan.paused || graph.summary.paused;
  const isPlanCancelled = graph.plan.state === 'abandoned' || graph.summary.plan_state === 'abandoned';

  return (
    <div className={classes.container}>
      <Head title={`Grafo do Plano: ${plan.title}`} />

      <header className={classes.header}>
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <div>
            <Group gap="xs" align="center">
              <Title order={2} size="h3">{plan.title}</Title>
              {isPlanPaused && <Badge color="orange" variant="filled">Pausado</Badge>}
              {isPlanCancelled && <Badge color="red" variant="filled">Cancelado</Badge>}
              {!isPlanPaused && !isPlanCancelled && <Badge color="teal" variant="light">Ativo</Badge>}
            </Group>
            <Text size="sm" c="dimmed">Chave: {plan.plan_key} • Versão {plan.version}</Text>
          </div>
          <Group gap="xs">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconRefresh size={14} />}
              loading={loading}
              onClick={fetchLatestGraph}
            >
              Atualizar
            </Button>
            {!isPlanCancelled && !isPlanPaused && (
              <>
                <Button
                  variant="filled"
                  color="blue"
                  size="xs"
                  leftSection={<IconPlayerPlay size={14} />}
                  loading={loading}
                  onClick={() => executePlanCommand('advance_dag')}
                >
                  Avançar DAG
                </Button>
                <Button
                  variant="light"
                  color="orange"
                  size="xs"
                  leftSection={<IconPlayerPause size={14} />}
                  loading={loading}
                  onClick={() => executePlanCommand('pause_plan', 'Pausa solicitada pelo operador')}
                >
                  Pausar
                </Button>
              </>
            )}
            {!isPlanCancelled && isPlanPaused && (
              <Button
                variant="filled"
                color="teal"
                size="xs"
                leftSection={<IconPlayerPlay size={14} />}
                loading={loading}
                onClick={() => executePlanCommand('resume_plan')}
              >
                Retomar
              </Button>
            )}
            {!isPlanCancelled && (
              <Button
                variant="subtle"
                color="red"
                size="xs"
                leftSection={<IconPlayerStop size={14} />}
                loading={loading}
                onClick={() => {
                  if (confirm('Tem certeza que deseja cancelar o plano operacional? Tarefas pendentes serão canceladas.')) {
                    executePlanCommand('cancel_plan', 'Cancelamento confirmado pelo operador');
                  }
                }}
              >
                Cancelar
              </Button>
            )}
          </Group>
        </Group>

        {commandFeedback && (
          <Text size="xs" c={commandFeedback.startsWith('Erro') ? 'red' : 'green'}>
            {commandFeedback}
          </Text>
        )}

        <div className={classes.summaryGrid}>
          <div className={classes.summaryCard}>
            <div className={classes.summaryCount}>{graph.summary.total_tasks}</div>
            <div className={classes.summaryLabel}>Total</div>
          </div>
          <div className={classes.summaryCard}>
            <div className={classes.summaryCount}>{graph.summary.integrated}</div>
            <div className={classes.summaryLabel}>Integradas</div>
          </div>
          <div className={classes.summaryCard}>
            <div className={classes.summaryCount}>{graph.summary.running}</div>
            <div className={classes.summaryLabel}>Em Execução</div>
          </div>
          <div className={classes.summaryCard}>
            <div className={classes.summaryCount}>{graph.summary.review}</div>
            <div className={classes.summaryLabel}>Em Revisão</div>
          </div>
          <div className={classes.summaryCard}>
            <div className={classes.summaryCount}>{graph.summary.needs_changes}</div>
            <div className={classes.summaryLabel}>Ajustes</div>
          </div>
          <div className={classes.summaryCard}>
            <div className={classes.summaryCount}>{graph.summary.waiting_dependencies}</div>
            <div className={classes.summaryLabel}>Em Espera</div>
          </div>
          <div className={classes.summaryCard}>
            <div className={classes.summaryCount}>{graph.summary.pending}</div>
            <div className={classes.summaryLabel}>Prontas</div>
          </div>
        </div>
      </header>

      <section className={classes.graphArea}>
        <Title order={4} size="h4">Tarefas e Dependências (RF-50)</Title>

        {/* Visualizador de Arestas e Fluxo de Dependências DAG (BUG-P2-03) */}
        {graph.edges && graph.edges.length > 0 && (
          <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(0, 0, 0, 0.03)', borderRadius: '8px' }}>
            <Text size="xs" fw={700} c="dimmed" style={{ marginBottom: '0.5rem', textTransform: 'uppercase' }}>
              Grafo Visual de Conexões e Dependências
            </Text>
            <svg style={{ width: '100%', height: '80px', overflow: 'visible' }}>
              <defs>
                <marker id="arrow-fulfilled" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#12b886" />
                </marker>
                <marker id="arrow-pending" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#fa5252" />
                </marker>
              </defs>
              {graph.edges.map((edge, idx) => {
                const total = graph.edges.length;
                const x1 = ((idx + 0.5) / (total + 1)) * 100;
                const x2 = ((idx + 1.2) / (total + 1)) * 100;
                return (
                  <g key={edge.id || `${edge.source_key}-${edge.target_key}`}>
                    <path
                      d={`M ${x1}% 20 Q ${(x1 + x2) / 2}% 50 ${x2}% 20`}
                      fill="none"
                      stroke={edge.fulfilled ? '#12b886' : '#fa5252'}
                      strokeWidth="2"
                      strokeDasharray={edge.fulfilled ? 'none' : '4'}
                      markerEnd={edge.fulfilled ? 'url(#arrow-fulfilled)' : 'url(#arrow-pending)'}
                    />
                    <text x={`${(x1 + x2) / 2}%`} y="65" fontSize="10" textAnchor="middle" fill="#666">
                      {edge.source_key} → {edge.target_key} ({edge.fulfilled ? 'Atendida' : 'Bloqueando'})
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        )}

        {graph.nodes.map((node) => (
          <div
            key={node.id}
            className={classes.nodeCard}
            onClick={() => setSelectedNode(node)}
            role="button"
            tabIndex={0}
          >
            <div className={classes.nodeHeader}>
              <span className={classes.nodeTitle}>{node.title}</span>
              <span className={classes.nodeKey}>{node.task_key}</span>
              <span className={`${classes.badge} ${getStateBadgeClass(node.state)}`}>
                {node.state}
              </span>
            </div>

            <div className={classes.nodeDetails}>
              <Text size="xs" c="dimmed">Papel: {node.assigned_role} • Risco: {node.risk_class} • Tentativas: {node.attempt_count}/{node.max_attempts}</Text>
            </div>

            {node.depends_on.length > 0 && (
              <div className={classes.edgeList}>
                <span>Depende de: {node.depends_on.join(', ')}</span>
              </div>
            )}
          </div>
        ))}
      </section>

      <footer className={classes.syncBar}>
        <span>Última sincronização do banco/workflow: {new Date(graph.projection_timestamp).toLocaleTimeString()}</span>
        <span>{graph.summary.all_completed ? 'Plano 100% Concluído' : 'Em Andamento'}</span>
      </footer>

      {/* Modal / Bottom Sheet sem dependência de hover (RNF-04) */}
      <Modal
        opened={!!selectedNode}
        onClose={() => setSelectedNode(null)}
        title={selectedNode?.title || 'Detalhes da Tarefa'}
        size="md"
      >
        {selectedNode && (
          <Stack gap="sm">
            <Group justify="space-between">
              <Text size="sm" fw={600}>Chave da Tarefa:</Text>
              <Text size="sm" ff="monospace">{selectedNode.task_key}</Text>
            </Group>
            <Group justify="space-between">
              <Text size="sm" fw={600}>Estado:</Text>
              <span className={`${classes.badge} ${getStateBadgeClass(selectedNode.state)}`}>
                {selectedNode.state}
              </span>
            </Group>
            <Group justify="space-between">
              <Text size="sm" fw={600}>Papel Atribuído:</Text>
              <Text size="sm">{selectedNode.assigned_role}</Text>
            </Group>
            <Group justify="space-between">
              <Text size="sm" fw={600}>Classe de Risco:</Text>
              <Text size="sm">{selectedNode.risk_class}</Text>
            </Group>
            <Group justify="space-between">
              <Text size="sm" fw={600}>Tentativas:</Text>
              <Text size="sm">{selectedNode.attempts_count} de {selectedNode.max_attempts}</Text>
            </Group>
            {selectedNode.approved_commit_sha && (
              <Group justify="space-between">
                <Text size="sm" fw={600}>Commit Aprovado:</Text>
                <Text size="sm" ff="monospace">{selectedNode.approved_commit_sha}</Text>
              </Group>
            )}
            <div>
              <Text size="sm" fw={600}>Escopo:</Text>
              <Text size="xs" c="dimmed">{selectedNode.scope}</Text>
            </div>
          </Stack>
        )}
      </Modal>
    </div>
  );
}
