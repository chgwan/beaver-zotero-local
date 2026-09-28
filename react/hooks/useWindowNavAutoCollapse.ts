import { useEffect, useState } from 'react';
import { useSurfaceWindow } from '../runtime/SurfaceWindowContext';
import { shouldForceCollapseWindowNav } from '../utils/windowNavCollapse';

/**
 * Whether the separate Beaver window is currently too narrow for its chat
 * history nav, regardless of the user's saved collapse preference.
 *
 * Subscribes to `resize` on the surface window (never bare `window`, since
 * the separate window's React tree can be hosted by a window other than the
 * one that loaded the bundle) and unsubscribes on unmount.
 */
export function useWindowNavAutoCollapse(): boolean {
    const surfaceWindow = useSurfaceWindow();
    const [forceCollapsed, setForceCollapsed] = useState(
        () => shouldForceCollapseWindowNav(surfaceWindow.innerWidth),
    );

    useEffect(() => {
        const update = () => setForceCollapsed(shouldForceCollapseWindowNav(surfaceWindow.innerWidth));
        update();
        surfaceWindow.addEventListener('resize', update);
        return () => surfaceWindow.removeEventListener('resize', update);
    }, [surfaceWindow]);

    return forceCollapsed;
}
