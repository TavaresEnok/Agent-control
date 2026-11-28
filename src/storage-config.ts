import {z} from 'zod';

/**
 * Orçamento e retenção de espaço do próprio Agent Control (installation.json, chave `storage`).
 * Os projetos ficam à parte: o orçamento mede só o que é do produto (repositório, dados da instalação,
 * temporários, backups, logins de trabalhadores, imagens e volumes Docker do AC).
 */
export const StorageConfig = z.object({
  /** Teto do Agent Control sem projetos, em GB. Alerta a `alertRatio` do teto; bloqueia novos exames e trabalhadores no teto. */
  budgetGB: z.number().min(1).max(10_000).default(20),
  alertRatio: z.number().min(0.5).max(1).default(0.9),
  /** Repositório do próprio Agent Control, para a retenção dos worktrees de desenvolvimento. Ausente: não mexe. */
  productRepo: z.string().refine(value => value.startsWith('/'), 'Absolute path required').optional(),
  /** Worktree integrado, sem mudança rastreada e parado há mais que isso sai com `git worktree remove` (o ramo fica). */
  worktreeIdleHours: z.number().min(1).max(24 * 90).default(2),
  /** Temporários `/tmp/ac-*` de rodadas encerradas saem depois disso. */
  tmpHours: z.number().min(1).max(24 * 30).default(24),
  /** Pastas de job nativo terminais e já retiradas são esvaziadas depois disso; o recibo fica no banco (só o digest da saída)
   * e `output/` e `request.json` ficam na pasta, porque o exame de segurança e o painel ainda os leem. */
  jobDirRetentionDays: z.number().min(1).max(365).default(7),
  verifyDb: z.object({
    /** Versões das bases de vulnerabilidade mantidas, contando a atual. */
    keep: z.number().int().min(1).max(4).default(1),
    /** Base Java do Trivy: `auto` só baixa quando algum projeto tem Java. */
    javaDb: z.enum(['auto', 'always', 'never']).default('auto'),
  }).strict().default({keep: 1, javaDb: 'auto'}),
  backups: z.object({
    /** Rotação com hardlink dos arquivos iguais entre backups (accounts, verificacoes). */
    dedupe: z.boolean().default(true),
    /** Backups avulsos com o prefixo da instalação saem depois disso, se houver um datado mais novo aprovado no restore-check. */
    looseDays: z.number().int().min(1).max(365).default(7),
  }).strict().default({dedupe: true, looseDays: 7}),
}).strict();

export type StorageSettings = z.infer<typeof StorageConfig>;

/** Configuração efetiva, com os padrões, para quem recebe a instalação já validada ou um objeto parcial. */
export function storageSettings(installation: {storage?: unknown} | undefined): StorageSettings {
  return StorageConfig.parse(installation?.storage ?? {});
}
