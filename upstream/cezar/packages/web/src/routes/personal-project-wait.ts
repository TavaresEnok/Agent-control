import { z } from 'zod'

import { agentControlFetch } from './settings/agent-control-fetch'

const projectsSchema = z.object({
  projects: z.array(z.object({ id: z.string() })),
  primaryProjectId: z.string().optional(),
})

export async function readPersonalProjects() {
  const response = await agentControlFetch('/api/v1/ac/projects', { cache: 'no-store' })
  if (!response.ok) throw new Error('PROJECTS_UNAVAILABLE')
  return projectsSchema.parse(await response.json())
}

/** Polls until the project is present or gone. Gives the gateway time to restart. */
export async function waitForPersonalProject(projectId: string, present: boolean) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const page = await readPersonalProjects()
      if (page.projects.some((project) => project.id === projectId) === present) return true
    } catch {
      // The gateway may be down while systemd starts it again.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return false
}
