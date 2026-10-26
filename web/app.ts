export {};
interface Delivery {
  id: string;
  event_id: string;
  type: string;
  endpoint_name: string;
  state: string;
  attempts: number;
  total_attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
}
interface Endpoint {
  id: string;
  name: string;
  target_id: string;
  subscription: string;
  active: number;
}
interface Entry {
  action: string;
  detail: string;
  created_at: number;
}
interface Overview {
  tenant: { name: string };
  counts: Record<string, number>;
  deliveries: Delivery[];
  endpoints: Endpoint[];
  audit: Entry[];
  nextCursor: string | null;
}
interface Config {
  demo: boolean;
  targets: { id: string }[];
}
const el = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(id);
  return value as T;
};
const demoKeys: Record<string, string> = {
  acme: 'demo_acme_public_token_0000000001',
  northstar: 'demo_northstar_public_token_00001',
};
let apiToken = '',
  version = 0,
  nextCursor: string | null = null,
  cursor: string | null = null;
const notice = (message: string, error = false): void => {
  el('notice').textContent = message;
  el('notice').className = error ? 'notice error' : 'notice';
};
async function api<T>(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  const data = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
  return data;
}
const cell = (value: string, className = ''): HTMLTableCellElement => {
  const td = document.createElement('td');
  td.textContent = value;
  td.className = className;
  return td;
};
const button = (
  label: string,
  action: (button: HTMLButtonElement) => Promise<void>,
  className = 'quiet',
): HTMLButtonElement => {
  const control = document.createElement('button');
  control.textContent = label;
  control.className = className;
  control.addEventListener('click', () => void run(control, () => action(control)));
  return control;
};
async function run(control: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  control.disabled = true;
  try {
    await action();
  } catch (error) {
    notice(error instanceof Error ? error.message : 'Request failed', true);
  } finally {
    control.disabled = false;
  }
}
function showDetail(title: string, content: string): void {
  el('detail-title').textContent = title;
  el('detail-content').textContent = content;
  el<HTMLDialogElement>('detail').showModal();
}
async function refresh(): Promise<void> {
  if (!apiToken) return;
  const revision = ++version;
  const state = el<HTMLSelectElement>('filter').value;
  const query = new URLSearchParams();
  if (state) query.set('state', state);
  if (cursor) query.set('cursor', cursor);
  try {
    const data = await api<Overview>(`/api/overview?${query}`);
    if (revision !== version) return;
    el('workspace-name').textContent = data.tenant.name;
    for (const state of ['pending', 'in_flight', 'succeeded', 'dead'])
      el(`count-${state}`).textContent = String(data.counts[state] ?? 0);
    el('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    const table = el('delivery-rows');
    table.replaceChildren();
    for (const delivery of data.deliveries) {
      const row = document.createElement('tr'),
        event = document.createElement('td');
      event.append(
        button(
          delivery.type,
          async () => {
            const result = await api<{ attempts: unknown[] }>(
              `/api/deliveries/${delivery.id}/attempts`,
            );
            showDetail(
              `Attempts · ${delivery.id.slice(0, 8)}`,
              JSON.stringify(result.attempts, null, 2),
            );
          },
          'event-link',
        ),
      );
      const id = document.createElement('small');
      id.textContent = delivery.id.slice(0, 8);
      event.append(id);
      const state = document.createElement('td'),
        badge = document.createElement('span');
      badge.className = `badge ${delivery.state}`;
      badge.textContent = delivery.state.replace('_', ' ');
      state.append(badge);
      const result = cell(
        delivery.last_status === null
          ? (delivery.last_error ?? 'Awaiting attempt')
          : `HTTP ${delivery.last_status}`,
      );
      const action = document.createElement('td');
      if (delivery.state === 'dead')
        action.append(
          button('Replay', async () => {
            el<HTMLInputElement>('replay-id').value = delivery.id;
            el<HTMLInputElement>('reason').value = '';
            el<HTMLDialogElement>('replay').showModal();
          }),
        );
      row.append(
        event,
        cell(delivery.endpoint_name),
        state,
        cell(`${delivery.attempts} / 5`, 'mono'),
        result,
        action,
      );
      table.append(row);
    }
    el('empty').hidden = data.deliveries.length !== 0;
    nextCursor = data.nextCursor;
    el<HTMLButtonElement>('next').disabled = nextCursor === null;
    el<HTMLButtonElement>('first').disabled = cursor === null;
    el('row-count').textContent = `${data.deliveries.length} deliveries on this page`;
    const endpoints = el('endpoint-list');
    endpoints.replaceChildren();
    for (const endpoint of data.endpoints) {
      const row = document.createElement('div');
      row.className = 'endpoint';
      const dot = document.createElement('span');
      dot.className = `dot ${endpoint.active ? 'on' : ''}`;
      const copy = document.createElement('div'),
        name = document.createElement('strong'),
        detail = document.createElement('small');
      name.textContent = endpoint.name;
      detail.textContent = `${endpoint.target_id} · ${endpoint.subscription}`;
      copy.append(name, detail);
      row.append(
        dot,
        copy,
        button(endpoint.active ? 'Pause' : 'Resume', async () => {
          await api(`/api/endpoints/${endpoint.id}/state`, { active: !endpoint.active });
          await refresh();
        }),
      );
      endpoints.append(row);
    }
    const audit = el('audit-list');
    audit.replaceChildren();
    for (const entry of data.audit) {
      const row = document.createElement('li'),
        label = document.createElement('strong'),
        detail = document.createElement('span'),
        time = document.createElement('time');
      label.textContent = entry.action;
      detail.textContent = entry.detail;
      time.textContent = new Date(entry.created_at).toLocaleTimeString();
      row.append(label, detail, time);
      audit.append(row);
    }
  } catch (error) {
    if (revision === version)
      notice(error instanceof Error ? error.message : 'Refresh failed', true);
  }
}
el<HTMLFormElement>('publish').addEventListener('submit', (event) => {
  event.preventDefault();
  void run(el<HTMLButtonElement>('publish-button'), async () => {
    const payload: unknown = JSON.parse(el<HTMLTextAreaElement>('payload').value);
    const result = await api<{ id: string; created: boolean; deliveries: number }>(
      '/api/events',
      { type: el<HTMLInputElement>('event-type').value, data: payload },
      { 'Idempotency-Key': el<HTMLInputElement>('idempotency').value },
    );
    notice(
      `${result.created ? 'Accepted' : 'Original event returned'} · ${result.id.slice(0, 8)} · ${result.deliveries} delivery records. The same key safely retries this request.`,
    );
    cursor = null;
    await refresh();
  });
});
el<HTMLButtonElement>('new-key').addEventListener('click', () => {
  el<HTMLInputElement>('idempotency').value = crypto.randomUUID();
  notice('New idempotency key: the next submission creates a new event.');
});
el<HTMLButtonElement>('refresh').addEventListener('click', () => void refresh());
el<HTMLSelectElement>('filter').addEventListener('change', () => {
  cursor = null;
  void refresh();
});
el<HTMLButtonElement>('next').addEventListener('click', () => {
  cursor = nextCursor;
  void refresh();
});
el<HTMLButtonElement>('first').addEventListener('click', () => {
  cursor = null;
  void refresh();
});
el<HTMLSelectElement>('workspace').addEventListener('change', () => {
  apiToken = demoKeys[el<HTMLSelectElement>('workspace').value] ?? '';
  cursor = null;
  notice('Workspace switched. Every request is authenticated for the selected tenant.');
  void refresh();
});
el<HTMLFormElement>('connect').addEventListener('submit', (event) => {
  event.preventDefault();
  apiToken = el<HTMLInputElement>('api-token').value;
  el<HTMLInputElement>('api-token').value = '';
  cursor = null;
  void refresh();
});
el<HTMLFormElement>('replay-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void run(el<HTMLButtonElement>('replay-submit'), async () => {
    await api(`/api/deliveries/${el<HTMLInputElement>('replay-id').value}/replay`, {
      reason: el<HTMLInputElement>('reason').value,
    });
    el<HTMLDialogElement>('replay').close();
    notice('Replay scheduled. Prior attempts remain in the ledger.');
    await refresh();
  });
});
el<HTMLButtonElement>('add-endpoint').addEventListener('click', () =>
  el<HTMLDialogElement>('endpoint-dialog').showModal(),
);
el<HTMLFormElement>('endpoint-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void run(el<HTMLButtonElement>('endpoint-submit'), async () => {
    const result = await api<{ signingSecret: string }>('/api/endpoints', {
      name: el<HTMLInputElement>('endpoint-name').value,
      targetId: el<HTMLSelectElement>('target').value,
      subscription: el<HTMLInputElement>('subscription').value,
    });
    el<HTMLDialogElement>('endpoint-dialog').close();
    showDetail(
      'Signing secret · shown once',
      `Configure this in the receiver. It cannot be retrieved from the API later.\n\n${result.signingSecret}`,
    );
    await refresh();
  });
});
for (const id of ['detail', 'replay', 'endpoint-dialog'])
  el<HTMLButtonElement>(`${id}-close`).addEventListener('click', () =>
    el<HTMLDialogElement>(id).close(),
  );
async function initialize(): Promise<void> {
  const config = (await (await fetch('/api/config')).json()) as Config;
  el('demo-note').hidden = !config.demo;
  el('workspace-control').hidden = !config.demo;
  el('connect').hidden = config.demo;
  for (const target of config.targets) {
    const option = document.createElement('option');
    option.value = target.id;
    option.textContent = target.id;
    el<HTMLSelectElement>('target').append(option);
  }
  el<HTMLInputElement>('idempotency').value = crypto.randomUUID();
  if (config.demo) {
    apiToken = demoKeys['acme']!;
    await refresh();
  }
}
void initialize().catch(() => notice('Unable to load service configuration', true));
