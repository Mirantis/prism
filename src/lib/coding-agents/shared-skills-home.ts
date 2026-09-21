/**
 * A coding agent's home in the execution environment, linked to the skills
 * the runtime already has.
 *
 * Both adapters want the same two things — the home exists, and `skills`
 * inside it points at the environment's skills dir — so they ask for it here
 * rather than each reaching for a filesystem of its own. The environment
 * decides which filesystem that is.
 */
import type { ExecutionEnvironment } from '../execution-environments/execution-environment';
import type { CodingAgentHome } from './coding-agent';

/**
 * Prepare `configDir`, unless an operator named it.
 *
 * A home the operator pointed at is theirs — usually their own `~/.claude` —
 * so nothing is created in it and the answer only reports whether the skills
 * happen to be linked there already. Every other home is the runtime's to set
 * up. `operatorHome` is the path they named, if any; it is compared rather
 * than merely tested, since an environment with a filesystem of its own
 * ignores a path that means nothing in it.
 */
export async function prepareSharedSkillsHome(
  environment: ExecutionEnvironment,
  configDir: string,
  operatorHome?: string,
): Promise<CodingAgentHome> {
  const { skillsDir } = environment.paths();
  const files = environment.files;
  const link = `${configDir}/skills`;

  if (operatorHome && operatorHome === configDir) {
    return { configDir, skillsLinked: await pointsAt(environment, link, skillsDir) };
  }

  await files.mkdir(configDir);
  try {
    await files.symlink(skillsDir, link);
  } catch {
    // A home that is not linked to the skills still runs tasks, so this is
    // reported rather than thrown; the startup log carries `skillsLinked`.
    return { configDir, skillsLinked: false };
  }
  return { configDir, skillsLinked: await pointsAt(environment, link, skillsDir) };
}

/** Whether the link really resolves to the skills dir, rather than merely existing. */
async function pointsAt(
  environment: ExecutionEnvironment,
  link: string,
  target: string,
): Promise<boolean> {
  try {
    const [from, to] = await Promise.all([
      environment.files.realpath(link),
      environment.files.realpath(target),
    ]);
    return from === to;
  } catch {
    return false;
  }
}
