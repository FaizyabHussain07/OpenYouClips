import type { CaptionTemplateId, ClipItem, ClipProject } from './types';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PersistedScreenState =
  | { view: 'create' }
  | { view: 'templates' }
  | { view: 'project'; projectId: string }
  | { view: 'editor'; projectId: string; clipId: string };

export interface PersistedWorkspacePayload {
  version: 1 | 2;
  projects: ClipProject[];
  defaultTemplate: CaptionTemplateId;
  lastScreen?: PersistedScreenState;
  savedAt: string;
}

export const WORKSPACE_STORAGE_KEY = 'openyouclips_workspace_v1';
export const DRAFTS_STORAGE_KEY = 'openyouclips_clip_drafts_v1';

function getDefaultStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function compactProjectsForQuota(projects: ClipProject[], limitCount = 12): ClipProject[] {
  return projects.slice(0, limitCount).map((p, idx) => {
    // Keep full fidelity on the newest 6 projects; trim bulky raw transcript text on older ones if storage quota is tight
    if (idx < 6) return p;
    return {
      ...p,
      transcript: p.transcript.slice(0, 60),
    };
  });
}

function migrateLegacyAutoHookBanners(projects: ClipProject[]): ClipProject[] {
  return projects.map((p) => ({
    ...p,
    clips: (p.clips ?? []).map((c) => {
      if (
        c.hookBanner?.enabled &&
        c.hookBanner.text === c.hookTitle &&
        c.hookBanner.durationSeconds === 3.5
      ) {
        return {
          ...c,
          hookBanner: { ...c.hookBanner, enabled: false },
        };
      }
      return c;
    }),
  }));
}

export function loadWorkspaceFromStorage(
  storage: StorageLike | null = getDefaultStorage(),
): PersistedWorkspacePayload | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspacePayload>;
    if (!Array.isArray(parsed.projects)) return null;
    const projects =
      parsed.version === 2
        ? parsed.projects
        : migrateLegacyAutoHookBanners(parsed.projects);
    return {
      version: 2,
      projects,
      defaultTemplate: parsed.defaultTemplate ?? 'hormozi',
      lastScreen: parsed.lastScreen,
      savedAt: parsed.savedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveWorkspaceToStorage(
  payload: Omit<PersistedWorkspacePayload, 'version' | 'savedAt'>,
  storage: StorageLike | null = getDefaultStorage(),
): boolean {
  if (!storage) return false;
  const fullPayload: PersistedWorkspacePayload = {
    version: 2,
    projects: payload.projects,
    defaultTemplate: payload.defaultTemplate,
    lastScreen: payload.lastScreen,
    savedAt: new Date().toISOString(),
  };

  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(fullPayload));
    return true;
  } catch {
    // Retry with compacted non-sample history if browser localStorage quota is nearly full
    try {
      const compacted: PersistedWorkspacePayload = {
        ...fullPayload,
        projects: compactProjectsForQuota(payload.projects, 10),
      };
      storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(compacted));
      return true;
    } catch {
      return false;
    }
  }
}

export function mergeProjectsWithLocalStorage(
  serverProjects: ClipProject[],
  localProjects: ClipProject[],
): ClipProject[] {
  const byId = new Map<string, ClipProject>();

  // Put local projects first so session-only projects survive server tmp clears
  for (const lp of localProjects) {
    if (lp && lp.id) {
      byId.set(lp.id, lp);
    }
  }

  for (const sp of serverProjects) {
    if (!sp || !sp.id) continue;
    const localMatch = byId.get(sp.id);
    if (!localMatch) {
      byId.set(sp.id, sp);
      continue;
    }
    // Prefer server copy when it is actively processing or completed with clips;
    // keep local edited clip details if local sample/project was customized more recently
    if (sp.stage !== 'completed' && sp.stage !== 'error') {
      byId.set(sp.id, sp);
    } else if (sp.clips.length >= localMatch.clips.length) {
      byId.set(sp.id, sp);
    }
  }

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function loadClipDraftFromStorage(
  clipId: string,
  storage: StorageLike | null = getDefaultStorage(),
): ClipItem | null {
  if (!storage || !clipId) return null;
  try {
    const raw = storage.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, { clip: ClipItem; updatedAt: string }>;
    return map[clipId]?.clip ?? null;
  } catch {
    return null;
  }
}

export function saveClipDraftToStorage(
  clip: ClipItem,
  storage: StorageLike | null = getDefaultStorage(),
): void {
  if (!storage || !clip?.id) return;
  try {
    const raw = storage.getItem(DRAFTS_STORAGE_KEY);
    const map = raw
      ? (JSON.parse(raw) as Record<string, { clip: ClipItem; updatedAt: string }>)
      : {};
    map[clip.id] = { clip, updatedAt: new Date().toISOString() };
    const entries = Object.entries(map)
      .sort((a, b) => new Date(b[1].updatedAt).getTime() - new Date(a[1].updatedAt).getTime())
      .slice(0, 25);
    storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Ignore storage quota errors on transient drafts
  }
}

export function clearClipDraftFromStorage(
  clipId: string,
  storage: StorageLike | null = getDefaultStorage(),
): void {
  if (!storage || !clipId) return;
  try {
    const raw = storage.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, { clip: ClipItem; updatedAt: string }>;
    if (clipId in map) {
      delete map[clipId];
      storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // Ignore
  }
}
