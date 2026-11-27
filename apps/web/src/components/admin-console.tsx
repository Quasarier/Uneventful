'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { API_BASE_URL } from '@/lib/auth-config';

type AdminSection = 'queue' | 'clubs' | 'venues' | 'users' | 'role-grants' | 'reports' | 'audit';
type AdminRecord = Record<string, unknown>;

interface PageResult {
  data: AdminRecord[];
  total?: number;
  nextCursor?: string | null;
}

const sections: Array<{ id: AdminSection; label: string; path: string }> = [
  { id: 'queue', label: 'Approval queue', path: '/admin/events/approval-queue' },
  { id: 'clubs', label: 'Clubs', path: '/admin/clubs' },
  { id: 'venues', label: 'Venues', path: '/admin/venues' },
  { id: 'users', label: 'Users', path: '/admin/users' },
  { id: 'role-grants', label: 'Admin role grants', path: '/admin/admin-grant-requests' },
  { id: 'reports', label: 'Reports', path: '/admin/reports' },
  { id: 'audit', label: 'Audit log', path: '/admin/audit-logs' },
];

export default function AdminConsole() {
  const { accessToken } = useAuth();
  const [section, setSection] = useState<AdminSection>('queue');
  const [records, setRecords] = useState<AdminRecord[]>([]);
  const [query, setQuery] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadSection = useCallback(async () => {
    if (!accessToken) return;
    const config = sections.find((item) => item.id === section);
    if (!config) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: '1', limit: '50' });
      if (section === 'users') {
        if (userSearch.trim().length < 2) {
          setRecords([]);
          setLoading(false);
          return;
        }
        params.set('search', userSearch.trim());
      } else if (query.trim()) {
        params.set('search', query.trim());
      }
      const response = await fetch(`${API_BASE_URL}${config.path}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = (await response.json()) as PageResult;
      setRecords(Array.isArray(result.data) ? result.data : []);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Administrator data could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken, query, section, userSearch]);

  useEffect(() => {
    void loadSection();
  }, [loadSection]);

  async function performAction(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    extra: AdminRecord = {},
  ) {
    if (!accessToken) return;
    if (!window.confirm('Continue with this administrator action?')) return;
    const reason = window.prompt('Enter the required reason:')?.trim() ?? '';
    if (!reason) {
      setError('A reason is required.');
      return;
    }
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify({ ...extra, reason }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setNotice('Action completed.');
      await loadSection();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The action could not be completed.');
    }
  }

  return (
    <section aria-labelledby="admin-title" className="space-y-6">
      <header>
        <p className="eyebrow">CampusPulse</p>
        <h1 className="mt-2 font-display text-3xl font-black" id="admin-title">
          Administration
        </h1>
      </header>
      <nav aria-label="Administrator sections" className="flex flex-wrap gap-2">
        {sections.map((item) => (
          <button
            aria-current={section === item.id ? 'page' : undefined}
            className="rounded-full border border-forest/20 px-4 py-2 text-sm font-bold text-forest"
            key={item.id}
            onClick={() => setSection(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>
      {section !== 'audit' && (
        <form
          className="flex flex-wrap gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (section === 'users') setUserSearch(query);
            else void loadSection();
          }}
        >
          <label className="sr-only" htmlFor="admin-search">
            Search {section}
          </label>
          <input
            className="min-w-64 rounded-xl border border-forest/20 bg-white px-4 py-3"
            id="admin-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={section === 'users' ? 'Search users (name or email)' : 'Filter results'}
            value={query}
          />
          <button className="rounded-xl bg-forest px-4 py-3 font-bold text-white" type="submit">
            Search
          </button>
        </form>
      )}
      {error && (
        <p className="rounded-xl bg-coral/10 p-4 text-coral" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-xl bg-forest/10 p-4 text-forest" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p aria-live="polite" role="status">
          Loading administrator data…
        </p>
      ) : (
        <div aria-live="polite" className="space-y-3">
          {records.length === 0 ? (
            <p className="rounded-2xl bg-white p-5 text-ink/70">No records to display.</p>
          ) : (
            records.map((record, index) => (
              <AdminRecordCard
                key={typeof record.id === 'string' ? record.id : `${section}-${index}`}
                onAction={performAction}
                record={record}
                section={section}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

function AdminRecordCard({
  record,
  section,
  onAction,
}: {
  record: AdminRecord;
  section: AdminSection;
  onAction: (
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    extra?: AdminRecord,
  ) => Promise<void>;
}) {
  const id = typeof record.id === 'string' ? record.id : '';
  const title =
    stringValue(record.title) ||
    stringValue(record.name) ||
    stringValue(record.action) ||
    stringValue(record.email) ||
    id;
  const details = Object.entries(record)
    .filter(([key, value]) => key !== 'id' && value !== null && typeof value !== 'object')
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ');

  return (
    <article className="rounded-2xl bg-white p-5 shadow-card">
      <h2 className="font-bold">{title}</h2>
      <p className="mt-2 break-words text-sm text-ink/70">{details}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {section === 'queue' && (
          <>
            <ActionButton
              label="Approve"
              onClick={() => onAction(`/admin/events/${id}/approve`, 'POST')}
            />
            <ActionButton
              label="Reject"
              onClick={() => onAction(`/admin/events/${id}/reject`, 'POST')}
            />
          </>
        )}
        {section === 'clubs' && (
          <>
            <ActionButton
              label="Verify"
              onClick={() =>
                onAction(`/admin/clubs/${id}/verification`, 'PATCH', { status: 'VERIFIED' })
              }
            />
            <ActionButton
              label="Unverify"
              onClick={() =>
                onAction(`/admin/clubs/${id}/verification`, 'PATCH', { status: 'UNVERIFIED' })
              }
            />
            <ActionButton
              label="Suspend"
              onClick={() =>
                onAction(`/admin/clubs/${id}/verification`, 'PATCH', { status: 'SUSPENDED' })
              }
            />
          </>
        )}
        {section === 'venues' && record.isActive === true && (
          <ActionButton
            label="Retire venue"
            onClick={() => onAction(`/admin/venues/${id}`, 'DELETE')}
          />
        )}
        {section === 'users' && record.role === 'STUDENT' && (
          <ActionButton
            label="Grant organizer membership"
            onClick={async () => {
              const clubId = window.prompt('Enter the club ID:')?.trim();
              if (!clubId) return;
              await onAction(`/admin/users/${id}/organizer-memberships/${clubId}`, 'POST');
            }}
          />
        )}
        {section === 'users' && record.role === 'ADMIN' && (
          <ActionButton
            label="Revoke admin role"
            onClick={() => onAction(`/admin/users/${id}/admin-role/revoke`, 'POST')}
          />
        )}
        {section === 'users' && record.isActive === true && (
          <ActionButton
            label="Suspend user"
            onClick={() => onAction(`/admin/users/${id}/suspend`, 'POST')}
          />
        )}
        {section === 'users' && record.isActive === false && (
          <ActionButton
            label="Reactivate user"
            onClick={() => onAction(`/admin/users/${id}/reactivate`, 'POST')}
          />
        )}
        {section === 'reports' && (
          <>
            <ActionButton
              label="Dismiss"
              onClick={() =>
                onAction(`/admin/reports/${id}/resolve`, 'POST', { action: 'DISMISS' })
              }
            />
            {record.targetType === 'EVENT' && (
              <>
                <ActionButton
                  label="Hide event"
                  onClick={() =>
                    onAction(`/admin/reports/${id}/resolve`, 'POST', { action: 'HIDE_EVENT' })
                  }
                />
                <ActionButton
                  label="Cancel event"
                  onClick={() =>
                    onAction(`/admin/reports/${id}/resolve`, 'POST', { action: 'CANCEL_EVENT' })
                  }
                />
              </>
            )}
            {record.targetType === 'CLUB' && (
              <ActionButton
                label="Suspend club"
                onClick={() =>
                  onAction(`/admin/reports/${id}/resolve`, 'POST', { action: 'SUSPEND_CLUB' })
                }
              />
            )}
          </>
        )}
        {section === 'role-grants' && (
          <ActionButton
            label="Approve admin grant"
            onClick={() => onAction(`/admin/admin-grant-requests/${id}/approve`, 'POST')}
          />
        )}
      </div>
    </article>
  );
}

function ActionButton({ label, onClick }: { label: string; onClick: () => Promise<void> }) {
  return (
    <button
      className="rounded-full border border-forest/20 px-3 py-2 text-sm font-semibold text-forest hover:bg-forest/5"
      onClick={() => void onClick()}
      type="button"
    >
      {label}
    </button>
  );
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
    ) {
      return body.message;
    }
  } catch {
    return `Request failed (${response.status}).`;
  }
  return `Request failed (${response.status}).`;
}
