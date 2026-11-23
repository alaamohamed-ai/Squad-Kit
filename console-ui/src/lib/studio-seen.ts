import { useEffect, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { DESIGN_SYSTEMS_PATH, SKETCHES_PATH, STUDIO_SEEN_EVENT, designSystemsKey, hasSeenStudio, saveStudioSeen, sketchesKey, type DesignSystemList, type SketchRow } from './studio';

/*
 * The sidebar's New badge on Studio (US-53, AB-178.1): shown until the person opens the Studio the first time in this
 * project, on this computer. The mark itself is in lib/studio; these are the hooks the pages and the sidebar use.
 */

/** Sets the mark when any Studio page opens; the sidebar hears it at once. */
export function markStudioSeen(project: string): void {
  if (saveStudioSeen(project)) window.dispatchEvent(new window.Event(STUDIO_SEEN_EVENT));
}

/** Follows the mark: set by a Studio page in this tab, or by another tab of this browser. */
export function useStudioSeen(project: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      window.addEventListener(STUDIO_SEEN_EVENT, changed);
      window.addEventListener('storage', changed);
      return () => {
        window.removeEventListener(STUDIO_SEEN_EVENT, changed);
        window.removeEventListener('storage', changed);
      };
    },
    () => hasSeenStudio(project),
  );
}

/** Marks the Studio seen for this project when any Studio page opens: the Studio, a sketch or a design system. */
export function useMarkStudioSeen(project: string | null | undefined): void {
  useEffect(() => {
    if (project) markStudioSeen(project);
  }, [project]);
}

/**
 * Whether the sidebar shows New: only while the mark is missing, and only once both lists have come back empty. They
 * are read with the Studio page's own queries, and only while the mark is missing, so New never flashes while they load.
 */
export function useStudioNew(project: string): boolean {
  const seen = useStudioSeen(project);
  const ask = !seen && Boolean(project);
  const sketches = useQuery({ queryKey: sketchesKey(project), queryFn: () => api<{ sketches: SketchRow[] }>(SKETCHES_PATH), enabled: ask });
  const systems = useQuery({ queryKey: designSystemsKey(project), queryFn: () => api<DesignSystemList>(DESIGN_SYSTEMS_PATH), enabled: ask });
  return ask && sketches.isSuccess && sketches.data.sketches.length === 0 && systems.isSuccess && systems.data.designSystems.length === 0;
}
