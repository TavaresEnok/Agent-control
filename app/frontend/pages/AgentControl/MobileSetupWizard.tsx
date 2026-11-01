import { Head } from '@inertiajs/react';
import { Button, Select, Stack, Text, TextInput } from '@mantine/core';
import { IconArrowLeft, IconArrowRight, IconCheck } from '@tabler/icons-react';
import { useState } from 'react';

import { apiFetch } from 'shared/lib/apiFetch';

import classes from './MobileSetupWizard.module.css';

interface RemoteEnvironmentOption {
  id: number;
  name: string;
  environmentSlug: string;
  state: string;
}

interface MobileSetupWizardProps {
  companyId: number;
  environments: RemoteEnvironmentOption[];
}

export default function MobileSetupWizard({ companyId, environments }: MobileSetupWizardProps) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Form State
  const [projectName, setProjectName] = useState('');
  const [contextTitle, setContextTitle] = useState('');
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(environments[0]?.id.toString() || null);
  const [executionRole, setExecutionRole] = useState<string | null>('programmer');
  const [effortLevel, setEffortLevel] = useState<string | null>('medium');

  const handleNext = () => {
    if (step < 4) setStep(step + 1);
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setFeedback(null);

    // Chave de idempotência do cliente (RF-53)
    const intentKey = JSON.stringify([companyId, projectName, contextTitle, selectedEnvId, executionRole, effortLevel]);
    const storageKey = `agent-control-mobile-setup:${intentKey}`;
    const intentId = sessionStorage.getItem(storageKey) || crypto.randomUUID();
    sessionStorage.setItem(storageKey, intentId);

    try {
      const res = await apiFetch('/api/v1/agent_control/client_commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          intent_id: intentId,
          command_type: 'setup_project_wizard',
          payload: {
            company_id: companyId,
            project_name: projectName,
            context_title: contextTitle,
            remote_environment_id: selectedEnvId,
            role: executionRole,
            effort_level: effortLevel,
          },
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setFeedback({
          type: 'success',
          message: data.deduplicated
            ? 'Configuração já realizada anteriormente (Deduplicada).'
            : 'Projeto e contexto configurados com sucesso pelo celular!',
        });
      } else {
        setFeedback({ type: 'error', message: data.error || 'Falha ao processar configuração.' });
      }
    } catch {
      setFeedback({ type: 'error', message: 'Erro de conexão ao enviar configuração.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={classes.container}>
      <Head title="Assistente Móvel de Configuração — Agent Control" />

      <div className={classes.wizardCard}>
        <div className={classes.stepIndicator}>
          <span className={classes.stepNumber}>Etapa {step} de 4</span>
          <Text size="xs" c="dimmed">
            RF-32 / RNF-04
          </Text>
        </div>

        {step === 1 && (
          <Stack gap="md">
            <div>
              <div className={classes.stepTitle}>1. Projeto e Contexto</div>
              <div className={classes.stepDesc}>Defina o escopo do projeto e o contexto de trabalho gerenciado.</div>
            </div>
            <TextInput
              label="Nome do Projeto"
              placeholder="ex: NexoISP Core"
              value={projectName}
              onChange={(e) => setProjectName(e.currentTarget.value)}
              required
            />
            <TextInput
              label="Contexto de Trabalho (RF-03)"
              placeholder="ex: Refatoração do Radius"
              value={contextTitle}
              onChange={(e) => setContextTitle(e.currentTarget.value)}
              required
            />
          </Stack>
        )}

        {step === 2 && (
          <Stack gap="md">
            <div>
              <div className={classes.stepTitle}>2. Ambiente Remoto (§14.2)</div>
              <div className={classes.stepDesc}>Vincule um destino SSH homologado para testes de integração.</div>
            </div>
            <Select
              label="Destino Autorizado"
              placeholder="Selecione o ambiente"
              data={environments.map((e) => ({ value: e.id.toString(), label: `${e.name} (${e.environmentSlug})` }))}
              value={selectedEnvId}
              onChange={setSelectedEnvId}
              required
            />
            <Text size="xs" c="dimmed">
              O transporte utiliza chave isolada ed25519 sem sudo nem autenticação de IAs no destino (§14.1).
            </Text>
          </Stack>
        )}

        {step === 3 && (
          <Stack gap="md">
            <div>
              <div className={classes.stepTitle}>3. Políticas e Perfis (RF-08)</div>
              <div className={classes.stepDesc}>Determine o papel padrão e o limite de esforço do modelo.</div>
            </div>
            <Select
              label="Papel Inicial"
              data={[
                { value: 'programmer', label: 'Programador (Codex / Claude Code)' },
                { value: 'reviewer', label: 'Revisor Independente' },
                { value: 'qa', label: 'Especialista de QA' },
              ]}
              value={executionRole}
              onChange={setExecutionRole}
            />
            <Select
              label="Limite de Esforço de Raciocínio"
              data={[
                { value: 'low', label: 'Baixo' },
                { value: 'medium', label: 'Médio' },
                { value: 'high', label: 'Alto' },
              ]}
              value={effortLevel}
              onChange={setEffortLevel}
            />
          </Stack>
        )}

        {step === 4 && (
          <Stack gap="md">
            <div>
              <div className={classes.stepTitle}>4. Confirmação e Envio</div>
              <div className={classes.stepDesc}>Revise os dados antes do envio atômico com deduplicação.</div>
            </div>
            <Stack gap="xs" style={{ background: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: 8 }}>
              <Text size="sm">
                <strong>Projeto:</strong> {projectName || '(não definido)'}
              </Text>
              <Text size="sm">
                <strong>Contexto:</strong> {contextTitle || '(não definido)'}
              </Text>
              <Text size="sm">
                <strong>Ambiente:</strong>{' '}
                {environments.find((e) => e.id.toString() === selectedEnvId)?.name || 'Nenhum'}
              </Text>
              <Text size="sm">
                <strong>Papel:</strong> {executionRole}
              </Text>
              <Text size="sm">
                <strong>Esforço:</strong> {effortLevel}
              </Text>
            </Stack>

            {feedback && (
              <div className={feedback.type === 'success' ? classes.feedbackSuccess : classes.feedbackError}>
                {feedback.message}
              </div>
            )}
          </Stack>
        )}

        <div className={classes.actions}>
          {step > 1 && (
            <Button
              variant="default"
              className={classes.actionButton}
              onClick={handleBack}
              leftSection={<IconArrowLeft size={16} />}
              disabled={loading}
            >
              Voltar
            </Button>
          )}

          {step < 4 ? (
            <Button
              variant="filled"
              color="blue"
              className={classes.actionButton}
              onClick={handleNext}
              rightSection={<IconArrowRight size={16} />}
            >
              Próximo
            </Button>
          ) : (
            <Button
              variant="filled"
              color="green"
              className={classes.actionButton}
              onClick={handleSubmit}
              loading={loading}
              leftSection={<IconCheck size={16} />}
            >
              Criar Configuração
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
