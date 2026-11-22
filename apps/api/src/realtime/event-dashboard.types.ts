export interface EventDashboardSnapshot {
  eventId: string;
  checkInCount: number;
  rsvpCount: number;
  attendanceRatio: number;
  capacity: number | null;
  recentCheckIns: Array<{
    displayName: string;
    checkedInAt: string;
  }>;
}

export const EVENT_DASHBOARD_PUBLISHER = Symbol('EVENT_DASHBOARD_PUBLISHER');

export interface EventDashboardPublisher {
  publishCheckIn(eventId: string): Promise<void>;
}
