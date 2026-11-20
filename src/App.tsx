import { useCallback, useEffect, useState } from 'react';
import { Captions, FolderKanban, Menu, PlusSquare, Scissors, X } from 'lucide-react';
import type { CaptionTemplateId, ClipProject } from './lib/types';
import {
  loadWorkspaceFromStorage,
  mergeProjectsWithLocalStorage,
  saveWorkspaceToStorage,
} from './lib/local-storage';
import { CreateStudioView } from './components/CreateStudioView';
import { ProjectClipWall } from './components/ProjectClipWall';
import { StudioEditor } from './components/StudioEditor';
import { TemplatesShowcaseView } from './components/TemplatesShowcaseView';

type StudioScreen =
  | { view: 'create' }
  | { view: 'templates' }
  | { view: 'project'; projectId: string }
  | { view: 'editor'; projectId: string; clipId: string };

export default function App() {
  const initialStorage = loadWorkspaceFromStorage();
  const [screen, setScreen] = useState<StudioScreen>(
    initialStorage?.lastScreen ?? { view: 'create' },
  );
  const [projects, setProjects] = useState<ClipProject[]>(initialStorage?.projects ?? []);
  const [loading, setLoading] = useState((initialStorage?.projects?.length ?? 0) === 0);
  const [geminiConfigured, setGeminiConfigured] = useState(true);
  const [defaultTemplate, setDefaultTemplate] = useState<CaptionTemplateId>(
    initialStorage?.defaultTemplate ?? 'hormozi',
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const loadWorkspace = useCallback(async () => {
    try {
      const [projRes, healthRes] = await Promise.all([
        fetch('/api/projects'),
        fetch('/api/health'),
      ]);
      if (projRes.ok) {
        const data = (await projRes.json()) as { projects: ClipProject[] };
        const serverList = data.projects ?? [];
        setProjects((prev) => {
          const cached = loadWorkspaceFromStorage()?.projects ?? prev;
          return mergeProjectsWithLocalStorage(serverList, cached);
        });
      }
      if (healthRes.ok) {
        const health = (await healthRes.json()) as { geminiConfigured?: boolean };
        setGeminiConfigured(Boolean(health.geminiConfigured));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  // Persist workspace projects, default caption template & session screen in browser localStorage
  useEffect(() => {
    saveWorkspaceToStorage({
      projects,
      defaultTemplate,
      lastScreen: screen,
    });
  }, [projects, defaultTemplate, screen]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [screen]);

  // Poll active background jobs while any project is processing
  const activeProcessingIds = projects
    .filter((p) => p.stage !== 'completed' && p.stage !== 'error')
    .map((p) => p.id);

  useEffect(() => {
    if (activeProcessingIds.length === 0) return;
    const timer = window.setInterval(() => {
      void (async () => {
        const updates = await Promise.all(
          activeProcessingIds.map(async (id) => {
            const r = await fetch(`/api/projects/${id}`);
            if (!r.ok) return null;
            const d = (await r.json()) as { project?: ClipProject };
            return d.project ?? null;
          }),
        );
        setProjects((prev) =>
          prev.map((p) => updates.find((u) => u && u.id === p.id) ?? p),
        );
      })();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [activeProcessingIds.join(',')]);

  const handleProjectCreated = (project: ClipProject) => {
    setProjects((prev) => [project, ...prev.filter((p) => p.id !== project.id)]);
    setScreen({ view: 'project', projectId: project.id });
    setMobileNavOpen(false);
  };

  const handleProjectUpdated = (updated: ClipProject) => {
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    } catch {
      // Also allow removing session-only browser projects
    }
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    if (screen.view !== 'create' && screen.view !== 'templates' && screen.projectId === projectId) {
      setScreen({ view: 'create' });
    }
  };

  // Full-screen immersive Studio Editor
  if (screen.view === 'editor') {
    const activeProject = projects.find((p) => p.id === screen.projectId);
    if (!activeProject) {
      setScreen({ view: 'create' });
      return null;
    }
    return (
      <StudioEditor
        project={activeProject}
        initialClipId={screen.clipId}
        onBackToProject={() =>
          setScreen({ view: 'project', projectId: activeProject.id })
        }
        onProjectUpdated={handleProjectUpdated}
      />
    );
  }

  const activeProject =
    screen.view === 'project'
      ? projects.find((p) => p.id === screen.projectId)
      : undefined;

  const sidebarContent = (
    <div className="flex h-full flex-col justify-between p-4">
      <div>
        <button
          type="button"
          onClick={() => {
            setScreen({ view: 'create' });
            setMobileNavOpen(false);
          }}
          className="mb-6 flex items-center gap-2.5 px-2 text-left"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#FF3B5C] text-white">
            <Scissors className="h-4 w-4" />
          </span>
          <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap">
            OpenYouClips
          </span>
        </button>

        <nav aria-label="Studio navigation" className="space-y-1">
          <button
            type="button"
            onClick={() => {
              setScreen({ view: 'create' });
              setMobileNavOpen(false);
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
              screen.view === 'create'
                ? 'bg-white/10 text-white'
                : 'text-slate-400 hover:bg-white/5 hover:text-white'
            }`}
          >
            <PlusSquare className="h-4 w-4 shrink-0" />
            Create Clips
          </button>

          <button
            type="button"
            onClick={() => {
              setScreen({ view: 'templates' });
              setMobileNavOpen(false);
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
              screen.view === 'templates'
                ? 'bg-white/10 text-white'
                : 'text-slate-400 hover:bg-white/5 hover:text-white'
            }`}
          >
            <Captions className="h-4 w-4 shrink-0" />
            Caption Templates
          </button>
        </nav>

        {/* Recent Projects Quick Jump */}
        <div className="mt-7 border-t border-white/8 pt-5">
          <div className="mb-2 flex items-center justify-between px-2 text-[11px] font-medium text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <FolderKanban className="h-3.5 w-3.5" />
              Projects
            </span>
            <span className="font-mono-tabular">{projects.length}</span>
          </div>
          <div className="space-y-1">
            {projects.slice(0, 8).map((proj) => {
              const isCurrent =
                screen.view === 'project' && screen.projectId === proj.id;
              return (
                <button
                  key={proj.id}
                  type="button"
                  onClick={() => {
                    setScreen({ view: 'project', projectId: proj.id });
                    setMobileNavOpen(false);
                  }}
                  className={`flex w-full flex-col rounded-lg px-2.5 py-2 text-left transition-colors ${
                    isCurrent
                      ? 'bg-[#FF3B5C]/14 text-white'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  }`}
                >
                  <span className="truncate text-xs font-medium">{proj.title}</span>
                  <span className="mt-0.5 text-[11px] text-slate-500 font-mono-tabular">
                    {proj.stage === 'completed'
                      ? `${proj.clips.length} clips`
                      : proj.stage === 'error'
                        ? 'Stopped'
                        : `${proj.progress}%`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="border-t border-white/8 pt-4 px-2 text-[11px] text-slate-500">
        Browser + Session Saved · No login required
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen w-full bg-[#090B10] text-[#F4F6FA]">
      {/* Desktop Sidebar */}
      <aside className="hidden w-60 shrink-0 border-r border-white/8 bg-[#11141C] lg:block">
        <div className="sticky top-0 h-screen overflow-y-auto">{sidebarContent}</div>
      </aside>

      {/* Mobile Header + Drawer */}
      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex h-14 items-center justify-between border-b border-white/8 bg-[#11141C] px-4 lg:hidden">
          <button
            type="button"
            onClick={() => setScreen({ view: 'create' })}
            className="flex items-center gap-2 font-display text-base font-bold text-white"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#FF3B5C]">
              <Scissors className="h-3.5 w-3.5 text-white" />
            </span>
            OpenYouClips
          </button>
          <button
            type="button"
            aria-label="Toggle studio menu"
            onClick={() => setMobileNavOpen((v) => !v)}
            className="rounded-lg border border-white/10 p-2 text-slate-200"
          >
            {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </header>

        {mobileNavOpen && (
          <div className="fixed inset-0 z-50 flex lg:hidden">
            <div className="w-64 bg-[#11141C] border-r border-white/10 h-full overflow-y-auto">
              {sidebarContent}
            </div>
            <div
              className="flex-1 bg-black/60"
              onClick={() => setMobileNavOpen(false)}
            />
          </div>
        )}

        <main className="flex-1">
          {loading ? (
            <div className="mx-auto max-w-6xl px-6 py-12 space-y-6">
              <div className="h-10 w-72 animate-pulse rounded-lg bg-white/8" />
              <div className="h-48 w-full animate-pulse rounded-2xl bg-white/6" />
            </div>
          ) : screen.view === 'templates' ? (
            <TemplatesShowcaseView
              selectedTemplate={defaultTemplate}
              onSelectDefaultTemplate={(tid) => {
                setDefaultTemplate(tid);
                setScreen({ view: 'create' });
              }}
            />
          ) : screen.view === 'project' && activeProject ? (
            <ProjectClipWall
              project={activeProject}
              onBack={() => setScreen({ view: 'create' })}
              onEditClip={(clipId) =>
                setScreen({
                  view: 'editor',
                  projectId: activeProject.id,
                  clipId,
                })
              }
              onProjectUpdated={handleProjectUpdated}
              onReclipCreated={handleProjectCreated}
            />
          ) : (
            <CreateStudioView
              projects={projects}
              defaultTemplate={defaultTemplate}
              geminiConfigured={geminiConfigured}
              onProjectCreated={handleProjectCreated}
              onOpenProject={(projectId) =>
                setScreen({ view: 'project', projectId })
              }
              onDeleteProject={(projectId) => void handleDeleteProject(projectId)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
