/**
 * PTY-based activity status tracker.
 *
 * Encapsulates the burst-detection algorithm that determines whether an
 * agent session is 'open', 'active', or needs 'attention'.
 *
 * Terminal-based agent adapters create an instance and feed it PTY data.
 * Future non-terminal agents can implement their own status logic without
 * using this class — the Agent interface only requires emitting status events.
 */

export type ActivityStatus = 'open' | 'active' | 'attention';

const BURST_IDLE_MS = 1000;      // 1s of PTY silence = burst ended
const BURST_PROMOTE_MS = 3000;   // 3s of sustained output = real work (not a re-render)

// Strip standard CSI escape sequences, keep visible characters (including Unicode)
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export class PtyActivityTracker {
  private userIsViewing = false;
  private currentStatus: ActivityStatus = 'open';
  private burstStartTime: number | null = null;
  private burstPromoted = false;
  private burstIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private preBurstStatus: ActivityStatus = 'open';

  constructor(private onStatusChange: (status: ActivityStatus) => void) {}

  /**
   * Call when PTY produces output.
   * Only visible content (after ANSI stripping) counts as activity.
   */
  onPtyData(data: string): void {
    const stripped = data.replace(ANSI_RE, '').replace(/[\r\n]+/g, ' ').trim();
    if (!stripped) return;

    const now = Date.now();

    // New burst: record pre-burst status and start time
    if (this.burstStartTime === null) {
      this.preBurstStatus = this.currentStatus;
      this.burstStartTime = now;
      this.burstPromoted = false;
    }

    // Check if burst should be promoted (sustained output >= BURST_PROMOTE_MS)
    if (!this.burstPromoted && (now - this.burstStartTime) >= BURST_PROMOTE_MS) {
      this.burstPromoted = true;
    }

    // Set active instantly for responsive UX
    this.setStatus('active');

    // Reset the idle timer — burst continues as long as data keeps flowing
    if (this.burstIdleTimer) clearTimeout(this.burstIdleTimer);
    this.burstIdleTimer = setTimeout(() => this.onBurstIdle(), BURST_IDLE_MS);
  }

  /** Called when the user focuses this session's tab. */
  onFocused(): void {
    this.userIsViewing = true;
    if (this.currentStatus === 'attention') {
      this.setStatus('open');
    }
  }

  /** Called when the user leaves this session's tab. */
  onBlurred(): void {
    this.userIsViewing = false;
  }

  /** Get current activity status. */
  getStatus(): ActivityStatus {
    return this.currentStatus;
  }

  /** Clean up timers. */
  dispose(): void {
    if (this.burstIdleTimer) {
      clearTimeout(this.burstIdleTimer);
      this.burstIdleTimer = null;
    }
  }

  /** PTY has been silent for BURST_IDLE_MS — the burst is over. */
  private onBurstIdle(): void {
    const wasPromoted = this.burstPromoted;

    // Clear burst tracking
    this.burstStartTime = null;
    this.burstPromoted = false;
    this.burstIdleTimer = null;

    if (wasPromoted) {
      if (this.userIsViewing) {
        this.setStatus('open');
      } else {
        this.setStatus('attention');
      }
    } else {
      // Short burst (re-render, keystroke echo) — revert, but respect viewing state
      if (this.userIsViewing) {
        this.setStatus('open');
      } else {
        this.setStatus(this.preBurstStatus);
      }
    }
  }

  private setStatus(status: ActivityStatus): void {
    if (status !== this.currentStatus) {
      this.currentStatus = status;
      this.onStatusChange(status);
    }
  }
}
