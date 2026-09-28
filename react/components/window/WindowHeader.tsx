import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { currentThreadIdAtom, currentThreadNameAtom } from '@beaver/agent-core/run-state/atoms';
import { isAuthenticatedAtom } from '../../atoms/auth';
import { localModeEnabledAtom } from '../../atoms/localMode';
import { toggleWindowNavAtom, windowNavCollapsedAtom } from '../../atoms/windowLayout';
import { SidebarLeftIcon } from '../icons/icons';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import ThreadMenuButton from '../ui/buttons/ThreadMenuButton';
import HeaderTrailingActions from '../HeaderTrailingActions';

interface WindowHeaderProps {
    /**
     * Whether a chat is on screen. Decides the sidebar toggle and the title
     * together, so the two cannot disagree.
     */
    showChat: boolean;
    /**
     * Whether the window is currently too narrow to show the nav, regardless
     * of the user's saved preference. Disables the toggle rather than letting
     * it flip a preference that would not visibly do anything, or open a nav
     * that has nowhere to fit.
     */
    navForceCollapsed: boolean;
}

/**
 * The separate window's header: the sidebar toggle, the open chat's title and
 * its actions on the left, the account on the right. The sidebar itself is
 * not part of it.
 */
const WindowHeader: React.FC<WindowHeaderProps> = ({ showChat, navForceCollapsed }) => {
    const collapsed = useAtomValue(windowNavCollapsedAtom);
    const toggleNav = useSetAtom(toggleWindowNavAtom);
    const threadId = useAtomValue(currentThreadIdAtom);
    // Kept current by the thread projection on every store snapshot, so a
    // rename lands here without another subscription.
    const threadName = useAtomValue(currentThreadNameAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const localMode = useAtomValue(localModeEnabledAtom);

    const title = threadId ? (threadName || 'Unnamed conversation') : 'New chat';
    const toggleLabel = navForceCollapsed
        ? 'Widen the window to show chat history'
        : (collapsed ? 'Show sidebar' : 'Hide sidebar');

    return (
        <header id="beaver-window-header" className="beaver-window-header">
            <div className="beaver-window-header-lead">
                {showChat && (
                    <>
                        <Tooltip content={toggleLabel} showArrow singleLine>
                            <IconButton
                                icon={SidebarLeftIcon}
                                onClick={() => toggleNav()}
                                className="scale-14"
                                ariaLabel={toggleLabel}
                                ariaPressed={!collapsed && !navForceCollapsed}
                                disabled={navForceCollapsed}
                            />
                        </Tooltip>
                        <div className="beaver-window-header-title-group">
                            <h1 className="beaver-window-header-title" title={title}>{title}</h1>
                            {threadId && (
                                <ThreadMenuButton className="scale-14 beaver-window-header-thread-menu" ariaLabel="Chat actions" inWindow />
                            )}
                        </div>
                    </>
                )}
            </div>

            {(isAuthenticated || localMode) && (
                <div className="beaver-window-header-trail">
                    <HeaderTrailingActions />
                </div>
            )}
        </header>
    );
};

export default WindowHeader;
