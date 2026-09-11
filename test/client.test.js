import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, eq, neq, gt, gte, lt, lte, in_, nin, like, ilike, isNull, isNotNull, rel, op, SynthigyError, composeTree, composeForest } from '../src/index.js'

// Mock fetch globally
const mockFetch = mock.fn()
global.fetch = mockFetch

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

describe('createClient', () => {
  it('requires token or client credentials', () => {
    // Only meaningful with no SYNTHIGY_TOKEN/SYNTHIGY_SUPERVISED in the
    // test environment — both are env-level fallbacks now
    // (PLAN-EXEC-IDENTITY step 3).
    assert.throws(
      () => createClient({ endpoint: 'http://localhost' }),
      (err) => err instanceof SynthigyError && err.code === 'NO_TOKEN'
    )
  })

  it('creates client with static token', () => {
    const client = createClient({
      endpoint: 'http://localhost',
      token: 'test-token',
    })
    assert.ok(client)
  })

  it('creates client with client credentials', () => {
    const client = createClient({
      endpoint: 'http://localhost',
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })
    assert.ok(client)
  })
})

describe('search', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('sends correct request format', async () => {
    const client = createClient({
      endpoint: 'http://localhost',
      token: 'test-token',
    })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(url, 'http://localhost/data')
      assert.equal(opts.headers['Authorization'], 'Bearer test-token')
      assert.equal(body.acting_as, undefined)
      assert.deepEqual(body.operations[0], {
        op: 'search',
        entity: 'user',
        args: { active: { _eq: true }, _limit: 10 },
        selections: { name: null, email: null },
      })
      return mockResponse(200, {
        results: [{ data: [{ name: 'Alice' }], ok: true }],
      })
    })

    const users = await client.search(
      'user',
      { active: eq(true), _limit: 10 },
      { name: null, email: null }
    )
    assert.deepEqual(users, [{ name: 'Alice' }])
  })

  it('passes actingAs per request', async () => {
    const client = createClient({
      endpoint: 'http://localhost',
      token: 'test-token',
    })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.acting_as, 'user-123')
      return mockResponse(200, {
        results: [{ data: [], ok: true }],
      })
    })

    await client.search('user', {}, { name: null }, { actingAs: 'user-123' })
  })

  it('does not include acting_as when not provided', async () => {
    const client = createClient({
      endpoint: 'http://localhost',
      token: 'test-token',
    })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.acting_as, undefined)
      return mockResponse(200, {
        results: [{ data: [], ok: true }],
      })
    })

    await client.search('user', {}, { name: null })
  })

  it('passes null args through to wire', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 'test-token' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.operations[0].args, null)
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('user', null, { name: null })
  })
})

describe('exec', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('sends multiple operations with actingAs', async () => {
    const client = createClient({
      endpoint: 'http://localhost',
      token: 'test-token',
    })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.acting_as, 'user-456')
      assert.equal(body.operations.length, 2)
      assert.equal(body.operations[0].op, 'slice')
      assert.equal(body.operations[1].op, 'stack')
      return mockResponse(200, {
        results: [
          { data: null, ok: true },
          { data: { euuid: 'u-1' }, ok: true },
        ],
      })
    })

    const results = await client.exec([
      op.slice('user', { euuid: 'u-1', roles: [{ euuid: 'r-old' }] }),
      op.stack('user', { euuid: 'u-1', roles: [{ euuid: 'r-new' }] }),
    ], { actingAs: 'user-456' })

    assert.equal(results.length, 2)
    assert.ok(results[0].ok)
    assert.ok(results[1].ok)
  })

  it('returns mixed ok/error results without throwing', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(200, {
        results: [
          { data: { xid: 'u-1' }, ok: true },
          { error: { message: 'Not found', code: 'NOT_FOUND' }, ok: false },
        ],
      })
    )

    const results = await client.exec([
      op.get('User', { xid: 'u-1' }, { name: null }),
      op.get('User', { xid: 'missing' }, { name: null }),
    ])

    assert.equal(results.length, 2)
    assert.ok(results[0].ok)
    assert.ok(!results[1].ok)
    assert.equal(results[1].error.code, 'NOT_FOUND')
  })

  it('throws when top-level error field is present', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(200, { error: { message: 'Bad request', code: 'BAD_REQUEST' } })
    )

    await assert.rejects(
      () => client.exec([op.search('User', {}, { name: null })]),
      (err) => err instanceof SynthigyError && err.code === 'BAD_REQUEST'
    )
  })
})

describe('mutations with actingAs', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('sync passes actingAs', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.acting_as, 'u-1')
      assert.equal(body.operations[0].op, 'sync')
      assert.deepEqual(body.operations[0].data, { xid: 'x', name: 'Alice' })
      return mockResponse(200, { results: [{ data: { xid: 'x' }, ok: true }] })
    })

    await client.sync('user', { xid: 'x', name: 'Alice' }, { actingAs: 'u-1' })
  })

  it('delete passes actingAs', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(200, { results: [{ data: null, ok: true }] })
    )

    await client.delete('user', { xid: 'x' }, { actingAs: 'u-1' })
  })
})

describe('error handling', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('classifies terminal codes as non-retryable (regression)', () => {
    // These previously fell through to internal (retryable=true), so a
    // retry-on-.retryable loop would spin forever on a missing audit
    // provider / no client. Must match the Python SDK, which had them right.
    for (const [code, category] of [
      ['HISTORY_UNAVAILABLE', 'not_found'],
      ['NOT_CONNECTED', 'validation'],
    ]) {
      const e = new SynthigyError('x', code)
      assert.equal(e.category, category, `${code} category`)
      assert.equal(e.retryable, false, `${code} must be non-retryable`)
    }
  })

  it('throws SynthigyError on 401', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 'bad' })

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(401, { error: { message: 'Unauthorized' } })
    )

    await assert.rejects(
      () => client.search('user', {}, { name: null }),
      (err) => err instanceof SynthigyError && err.code === 'UNAUTHORIZED'
    )
  })

  it('throws SynthigyError on 403 with FORBIDDEN code', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(403, { error: { message: 'Access denied', code: 'FORBIDDEN' } })
    )

    await assert.rejects(
      () => client.search('user', {}, { name: null }),
      (err) => err instanceof SynthigyError && err.code === 'FORBIDDEN' && err.message === 'Access denied'
    )
  })

  it('falls back to FORBIDDEN code when 403 body has no code', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async () => ({
      ok: false, status: 403,
      json: async () => ({}),
      text: async () => '',
    }))

    await assert.rejects(
      () => client.search('user', {}, { name: null }),
      (err) => err instanceof SynthigyError && err.code === 'FORBIDDEN'
    )
  })

  it('throws HTTP_ERROR on 5xx with response text in details', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async () => ({
      ok: false, status: 500,
      json: async () => { throw new Error('not json') },
      text: async () => 'Internal Server Error',
    }))

    await assert.rejects(
      () => client.search('user', {}, { name: null }),
      (err) => {
        assert.ok(err instanceof SynthigyError)
        assert.equal(err.code, 'HTTP_ERROR')
        assert.ok(err.message.includes('500'))
        assert.equal(err.details, 'Internal Server Error')
        return true
      }
    )
  })

  it('throws SynthigyError on operation error', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(200, {
        results: [{ error: { message: 'Not found', code: 'NOT_FOUND' }, ok: false }],
      })
    )

    await assert.rejects(
      () => client.get('user', { euuid: 'x' }, { name: null }),
      (err) => err instanceof SynthigyError && err.code === 'NOT_FOUND'
    )
  })

  it('SynthigyError has correct name, code, and details properties', () => {
    const err = new SynthigyError('Something went wrong', 'MY_CODE', { extra: 1 })
    assert.equal(err.name, 'SynthigyError')
    assert.equal(err.message, 'Something went wrong')
    assert.equal(err.code, 'MY_CODE')
    assert.deepEqual(err.details, { extra: 1 })
    assert.ok(err instanceof Error)
  })
})

describe('operators', () => {
  it('builds correct filter objects', () => {
    assert.deepEqual(eq(true), { _eq: true })
    assert.deepEqual(gt(5), { _gt: 5 })
    assert.deepEqual(in_(1, 2, 3), { _in: [1, 2, 3] })
    assert.deepEqual(like('%test%'), { _like: '%test%' })
    assert.deepEqual(isNull(), { _is_null: true })
  })
})

describe('args passthrough', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('sends args as-is to wire', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].args, {
        name: { _eq: 'Alice' },
        active: { _eq: true },
        age: { _gt: 18 },
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {
      name: eq('Alice'), active: eq(true), age: gt(18),
    }, ['name'])
  })

  it('passes _limit, _offset, _order_by unchanged', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].args, {
        _limit: 10,
        _offset: 0,
        _order_by: { name: 'asc' },
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', { _limit: 10, _offset: 0, _order_by: { name: 'asc' } }, ['name'])
  })

  it('passes _where clause unchanged', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].args, {
        _where: {
          _or: [{ role: { _eq: 'admin' } }, { role: { _eq: 'superuser' } }],
        },
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {
      _where: {
        _or: [{ role: eq('admin') }, { role: eq('superuser') }],
      },
    }, ['name'])
  })

  it('passes in_() and nin() operators', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].args, {
        status: { _in: ['active', 'pending'] },
        type: { _nin: ['bot'] },
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {
      status: in_('active', 'pending'),
      type: { _nin: ['bot'] },
    }, ['name'])
  })
})

describe('rel', () => {
  it('builds relation selection', () => {
    assert.deepEqual(rel({ name: null }), { selections: { name: null } })
  })

  it('builds relation selection with args', () => {
    assert.deepEqual(rel({ name: null }, { _limit: 5 }), {
      selections: { name: null }, args: { _limit: 5 },
    })
  })

  it('builds relation selection with alias', () => {
    assert.deepEqual(rel({ name: null }, { _limit: 5 }, 'active'), {
      selections: { name: null }, args: { _limit: 5 }, alias: 'active',
    })
  })

  it('multiple rel() in array form works in selection', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.resetCalls()
    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections.roles, [
        { selections: { name: null }, args: { _limit: 5 }, alias: 'a' },
        { selections: { name: null }, args: { _limit: 5 }, alias: 'b' },
      ])
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, {
      roles: [
        rel({ name: null }, { _limit: 5 }, 'a'),
        rel({ name: null }, { _limit: 5 }, 'b'),
      ],
    })
  })
})

describe('selection normalization', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('wraps plain object relations as [{ selections: ... }]', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, {
        name: null,
        roles: [{ selections: { name: null, type: null } }],
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    // User writes shorthand — plain object for relation
    await client.search('User', {}, {
      name: null,
      roles: { name: null, type: null },
    })
  })

  it('leaves explicit array form untouched', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, {
        name: null,
        roles: [
          { alias: 'activeRoles', args: { _limit: 5 }, selections: { name: null } },
        ],
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    // User writes explicit array form with alias + args
    await client.search('User', {}, {
      name: null,
      roles: [{ alias: 'activeRoles', args: { _limit: 5 }, selections: { name: null } }],
    })
  })

  it('handles deeply nested shorthand', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, {
        name: null,
        organization: [{ selections: {
          name: null,
          departments: [{ selections: {
            name: null,
            manager: [{ selections: { name: null, email: null } }],
          } }],
        } }],
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    // Deep nesting with shorthand — no arrays anywhere
    await client.search('User', {}, {
      name: null,
      organization: {
        name: null,
        departments: {
          name: null,
          manager: { name: null, email: null },
        },
      },
    })
  })

  it('accepts true instead of null for scalars', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, {
        name: null,
        email: null,
        active: null,
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, { name: true, email: true, active: true })
  })

  it('accepts array of strings as flat selection', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, {
        name: null,
        email: null,
        active: null,
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, ['name', 'email', 'active'])
  })

  it('accepts array of strings inside relations', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, {
        name: null,
        roles: [{ selections: { name: null, type: null } }],
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, {
      name: true,
      roles: ['name', 'type'],
    })
  })

  it('mixes all shorthand forms', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, {
        name: null,
        email: null,
        roles: [{ selections: { name: null, type: null } }],
        organization: [{ selections: {
          name: null,
          departments: [{ selections: { name: null } }],
        } }],
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, {
      name: true,
      email: null,
      roles: ['name', 'type'],
      organization: {
        name: true,
        departments: ['name'],
      },
    })
  })

  it('rel() helper still works for args/alias', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, {
        name: null,
        roles: [{ selections: { name: null }, args: { _limit: 5 } }],
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, {
      name: null,
      roles: rel({ name: null }, { _limit: 5 }),
    })
  })

  it('injects no _join — bare stays bare, explicit _join passes through', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, {
        // bare relation travels as written — server defaults it LEFT
        roles: [{ selections: { name: null } }],
        // explicit inner passes through (parent scoping is caller intent)
        groups: [{ selections: { name: null }, args: { _join: 'inner' } }],
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, {
      roles: { name: null },
      groups: rel({ name: null }, { _join: 'inner' }),
    })
  })

  it('does not inject _join into _count / _agg subtrees', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, {
        title: null,
        // aggregate operators keep their LEFT-by-construction shape, no sugar
        _count: [{ selections: { actors: null } }],
        _agg: [{ selections: { ratings: [{ selections: { rating: [{ selections: { _avg: null } }] } }] } }],
      })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('Movie', {}, {
      title: null,
      _count: { actors: null },
      _agg: { ratings: { rating: { _avg: null } } },
    })
  })
})

describe('client credentials', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('fetches token before first request', async () => {
    const client = createClient({
      endpoint: 'http://localhost',
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })

    let callCount = 0
    mockFetch.mock.mockImplementation(async (url, opts) => {
      callCount++
      if (callCount === 1) {
        assert.equal(url, 'http://localhost/oauth/token')
        assert.ok(opts.body.toString().includes('grant_type=client_credentials'))
        return mockResponse(200, {
          access_token: 'fetched-token',
          expires_in: 3600,
        })
      }
      assert.equal(opts.headers['Authorization'], 'Bearer fetched-token')
      return mockResponse(200, {
        results: [{ data: [], ok: true }],
      })
    })

    await client.search('user', {}, { name: null })
    assert.equal(callCount, 2)
  })
})

describe('get', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('sends correct op and returns data', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0], {
        op: 'get',
        entity: 'User',
        args: { xid: 'u-1' },
        selections: { name: null, email: null },
      })
      return mockResponse(200, { results: [{ data: { xid: 'u-1', name: 'Alice' }, ok: true }] })
    })

    const user = await client.get('User', { xid: 'u-1' }, { name: null, email: null })
    assert.deepEqual(user, { xid: 'u-1', name: 'Alice' })
  })

  it('returns null when record not found', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(200, { results: [{ data: null, ok: true }] })
    )

    const result = await client.get('User', { xid: 'missing' }, { name: null })
    assert.equal(result, null)
  })
})

describe('sqlTemplate', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('sends sql-template op with template and params', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0], {
        op: 'sql-template',
        template: 'SELECT {user.name}, COUNT(*) FROM {user} WHERE {user.active} = ?',
        params: [true],
      })
      return mockResponse(200, { results: [{ data: [{ name: 'Alice', count: 1 }], ok: true }] })
    })

    const rows = await client.sqlTemplate(
      'SELECT {user.name}, COUNT(*) FROM {user} WHERE {user.active} = ?', [true]
    )
    assert.deepEqual(rows, [{ name: 'Alice', count: 1 }])
  })

  it('defaults params to [] when omitted', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].params, [])
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.sqlTemplate('SELECT 1')
  })
})

describe('tree ops', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('searchTree sends search-tree op and composes into a forest', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0], {
        op: 'search-tree',
        entity: 'Department',
        on: 'parent',
        args: { _limit: 50 },
        selections: { name: null },
      })
      return mockResponse(200, { results: [{ data: [
        { xid: 'd-1', name: 'HQ',   parent: null },
        { xid: 'd-2', name: 'Eng',  parent: { xid: 'd-1' } },
      ], ok: true }] })
    })

    const forest = await client.searchTree('Department', 'parent', { _limit: 50 }, { name: null })
    assert.equal(forest.length, 1)
    assert.equal(forest[0].xid, 'd-1')
    assert.equal(forest[0]._children.length, 1)
    assert.equal(forest[0]._children[0].xid, 'd-2')
  })

  it('searchTree raw: true returns flat array', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const flat = [{ xid: 'd-1', name: 'HQ', parent: null }]

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(200, { results: [{ data: flat, ok: true }] })
    )

    const rows = await client.searchTree('Department', 'parent', {}, { name: null }, { raw: true })
    assert.deepEqual(rows, flat)
  })

  it('getTree sends get-tree op and composes into a tree', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0], {
        op: 'get-tree',
        entity: 'Department',
        root: 'd-root',
        on: 'parent',
        selections: { name: null },
      })
      return mockResponse(200, { results: [{ data: [
        { xid: 'd-root', name: 'HQ',  parent: null },
        { xid: 'd-child', name: 'Eng', parent: { xid: 'd-root' } },
      ], ok: true }] })
    })

    const tree = await client.getTree('Department', 'd-root', 'parent', { name: null })
    assert.equal(tree.xid, 'd-root')
    assert.equal(tree._children.length, 1)
    assert.equal(tree._children[0].xid, 'd-child')
  })

  it('getTree raw: true returns flat array', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const flat = [{ xid: 'd-root', name: 'HQ', parent: null }]

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(200, { results: [{ data: flat, ok: true }] })
    )

    const rows = await client.getTree('Department', 'd-root', 'parent', { name: null }, { raw: true })
    assert.deepEqual(rows, flat)
  })

  it('getTree returns null when root is not found in result', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(200, { results: [{ data: [], ok: true }] })
    )

    const tree = await client.getTree('Department', 'd-missing', 'parent', { name: null })
    assert.equal(tree, null)
  })
})

describe('write ops', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('stack sends stack op', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0], {
        op: 'stack',
        entity: 'User',
        data: { xid: 'u-1', roles: [{ xid: 'r-1' }] },
        returning: false,
      })
      return mockResponse(200, { results: [{ data: { xid: 'u-1' }, ok: true }] })
    })

    const result = await client.stack('User', { xid: 'u-1', roles: [{ xid: 'r-1' }] })
    assert.deepEqual(result, { xid: 'u-1' })
  })

  it('slice sends slice op', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.operations[0].op, 'slice')
      assert.deepEqual(body.operations[0].args, { xid: 'u-1', roles: [{ xid: 'r-old' }] })
      return mockResponse(200, { results: [{ data: null, ok: true }] })
    })

    await client.slice('User', { xid: 'u-1', roles: [{ xid: 'r-old' }] })
  })

  it('slice selection stays bare (no injected _join)', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      // no op ever injects _join; slice pins it since the server once
      // treated an injected _join as a targeting constraint here
      assert.deepEqual(body.operations[0].selections,
        { roles: [{ selections: { xid: null } }] })
      return mockResponse(200, { results: [{ data: { roles: true }, ok: true }] })
    })

    await client.slice('User', { xid: 'u-1' }, { roles: { xid: null } })
  })

  it('slice sends selection on wire', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, { xid: null, name: null })
      return mockResponse(200, { results: [{ data: { xid: 'u-1' }, ok: true }] })
    })

    await client.slice('User', { xid: 'u-1' }, { xid: null, name: null })
  })

  it('slice omits selection key when no selection passed', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal('selection' in body.operations[0], false)
      return mockResponse(200, { results: [{ data: { roles: true }, ok: true }] })
    })

    const result = await client.slice('User', { xid: 'u-1' })
    assert.deepEqual(result, { roles: true })
  })

  it('purge sends purge op', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.operations[0].op, 'purge')
      assert.deepEqual(body.operations[0].args, { active: { _eq: false } })
      return mockResponse(200, { results: [{ data: { count: 3 }, ok: true }] })
    })

    const result = await client.purge('User', { active: eq(false) })
    assert.deepEqual(result, { count: 3 })
  })

  it('purge passes opts.selection', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.operations[0].selections, { xid: null, name: null })
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.purge('User', { active: eq(false) }, { xid: null, name: null })
  })
})

describe('subscriptions (records-only set-replace contract)', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('subscribe accepts an array of xids and POSTs full-set body to /data/subscription/set', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      assert.equal(url, 'http://localhost/data/subscription/set')
      assert.equal(opts.method, 'POST')
      assert.equal(opts.headers['Authorization'], 'Bearer t')
      const body = JSON.parse(opts.body)
      assert.deepEqual(body, {
        subscriptions: [{ type: 'data', records: ['u-abc', 'u-def'] }],
      })
      return mockResponse(200, { ok: true })
    })

    const result = await client.subscribe(['u-def', 'u-abc'])  // unsorted input
    assert.deepEqual(result, { ok: true })
  })

  it('subscribe accepts a descriptor object with operations', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.subscriptions, [{
        type: 'data', records: ['u-abc'], operations: ['link', 'update'],
      }])
      return mockResponse(200, { ok: true })
    })

    await client.subscribe({ records: ['u-abc'], operations: ['update', 'link'] })
  })

  it('subscribe rejects the legacy entity-firehose string form with a clear error', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    await assert.rejects(
      () => client.subscribe('User'),
      (err) => err instanceof SynthigyError && err.code === 'INVALID_SUBSCRIPTION'
    )
  })

  it('subscribe rejects empty records arrays', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    await assert.rejects(
      () => client.subscribe([]),
      (err) => err instanceof SynthigyError && err.code === 'EMPTY_RECORDS'
    )
    await assert.rejects(
      () => client.subscribe({ records: [] }),
      (err) => err instanceof SynthigyError && err.code === 'EMPTY_RECORDS'
    )
  })

  it('two subscribes with different records accumulate as two items', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const bodies = []

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return mockResponse(200, { ok: true })
    })

    await client.subscribe(['u-1'])
    await client.subscribe(['u-2'])

    assert.equal(bodies.length, 2)
    assert.deepEqual(bodies[0].subscriptions, [{ type: 'data', records: ['u-1'] }])
    assert.deepEqual(bodies[1].subscriptions, [
      { type: 'data', records: ['u-1'] },
      { type: 'data', records: ['u-2'] },
    ])
  })

  it('re-subscribing with the same descriptor is idempotent (same hash key)', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const bodies = []

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return mockResponse(200, { ok: true })
    })

    await client.subscribe(['u-1', 'u-2'])
    await client.subscribe(['u-2', 'u-1'])  // same records, different order

    // Both POSTs land but the second is identical to the first.
    assert.equal(bodies.length, 2)
    assert.deepEqual(bodies[0].subscriptions, [{ type: 'data', records: ['u-1', 'u-2'] }])
    assert.deepEqual(bodies[1].subscriptions, [{ type: 'data', records: ['u-1', 'u-2'] }])
  })

  it('explicit key replaces prior opts under the same key', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const bodies = []

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return mockResponse(200, { ok: true })
    })

    await client.subscribe(['u-1'], { key: 'page' })
    await client.subscribe(['u-2'], { key: 'page' })

    assert.deepEqual(bodies[1].subscriptions, [{ type: 'data', records: ['u-2'] }])
  })

  it('unsubscribe by key removes that entry only', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const bodies = []

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return mockResponse(200, { ok: true })
    })

    await client.subscribe(['u-1'], { key: 'a' })
    await client.subscribe(['u-2'], { key: 'b' })
    await client.unsubscribe('a')

    assert.deepEqual(bodies[2].subscriptions, [{ type: 'data', records: ['u-2'] }])
  })

  it('unsubscribe by descriptor matches the hash key set at subscribe time', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const bodies = []

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return mockResponse(200, { ok: true })
    })

    await client.subscribe(['u-1'])
    await client.subscribe(['u-2'])
    await client.unsubscribe(['u-1'])    // descriptor form

    assert.deepEqual(bodies[2].subscriptions, [{ type: 'data', records: ['u-2'] }])
  })

  it('unsubscribe is a no-op (no HTTP call) when handle is unknown', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    let calls = 0
    mockFetch.mock.mockImplementation(async () => {
      calls++
      return mockResponse(200, { ok: true })
    })

    const result = await client.unsubscribe('unknown-key')
    assert.deepEqual(result, { ok: true })
    assert.equal(calls, 0, 'no HTTP call when handle is unknown')
  })

  it('subscribeModel adds runtime-model by default', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.subscriptions, [{ type: 'runtime-model' }])
      return mockResponse(200, { ok: true })
    })

    await client.subscribeModel()
  })

  it('subscribeModel({raw:true}) uses deployed-model type', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.subscriptions, [{ type: 'deployed-model' }])
      return mockResponse(200, { ok: true })
    })

    await client.subscribeModel({ raw: true })
  })

  it('setSubscriptions replaces the entire local set with descriptor items', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const bodies = []

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return mockResponse(200, { ok: true })
    })

    await client.subscribe(['old-1'])
    await client.setSubscriptions([
      { type: 'data', records: ['a-1', 'a-2'] },
      { type: 'data', records: ['b-1'], operations: ['update'] },
      { type: 'runtime-model' },
    ])

    assert.deepEqual(bodies[1].subscriptions, [
      { type: 'data', records: ['a-1', 'a-2'] },
      { type: 'data', records: ['b-1'], operations: ['update'] },
      { type: 'runtime-model' },
    ])
  })

  it('setSubscriptions validates each item with the same rules as subscribe()', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    await assert.rejects(
      () => client.setSubscriptions([{ type: 'data' }]),
      (err) => err instanceof SynthigyError && err.code === 'INVALID_SUBSCRIPTION'
    )
    await assert.rejects(
      () => client.setSubscriptions([{ type: 'data', records: [] }]),
      (err) => err instanceof SynthigyError && err.code === 'EMPTY_RECORDS'
    )
  })

  it('clearSubscriptions POSTs empty set', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const bodies = []

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      bodies.push(JSON.parse(opts.body))
      return mockResponse(200, { ok: true })
    })

    await client.subscribe(['u-1'])
    await client.clearSubscriptions()

    assert.deepEqual(bodies[bodies.length - 1], { subscriptions: [] })
  })

  it('subscriptions() GETs /data/subscription/status', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      assert.equal(url, 'http://localhost/data/subscription/status')
      assert.equal(opts.headers['Authorization'], 'Bearer t')
      return mockResponse(200, {
        subscriptions: [{ type: 'data', records: ['u-1'] }],
      })
    })

    const result = await client.subscriptions()
    assert.deepEqual(result, {
      subscriptions: [{ type: 'data', records: ['u-1'] }],
    })
  })

  it('subscribe throws SynthigyError when the server rejects the body', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(400, { error: { message: 'records required', code: 'MISSING_RECORDS' } })
    )

    await assert.rejects(
      () => client.subscribe(['u-1']),
      (err) => err instanceof SynthigyError && err.code === 'MISSING_RECORDS'
    )
  })
})

describe('query (XSQL + named params)', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('POSTs the xsql DOCUMENT op with a synthetic header + params map', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      assert.equal(url, 'http://localhost/data')
      const body = JSON.parse(opts.body)
      assert.equal(body.operations.length, 1)
      const op = body.operations[0]
      assert.equal(op.op, 'xsql')
      assert.equal(op.entity, undefined)      // STRICT: document carries it
      assert.equal(op.selections, undefined)
      assert.ok(op.xsql.startsWith('@search _q\n'))
      assert.ok(op.xsql.includes('?a:boolean'))
      assert.deepEqual(op.params, { a: true, n: 25 })
      return mockResponse(200, { results: [{ ok: true, data: [{ name: 'Alice' }] }] })
    })

    const out = await client.query(
      `user (active = ?a:boolean, limit ?n:int)\n  name\n`,
      { a: true, n: 25 }
    )
    assert.deepEqual(out, [{ name: 'Alice' }])
  })

  it('passes @-document sources through verbatim', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const op = JSON.parse(opts.body).operations[0]
      assert.equal(op.xsql, '@search list\nuser\n  name\n')
      return mockResponse(200, { results: [{ ok: true, data: [] }] })
    })

    await client.query('@search list\nuser\n  name\n')
  })

  it('defaults op to "search"', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const op = JSON.parse(opts.body).operations[0]
      assert.equal(op.op, 'xsql')
      assert.ok(op.xsql.startsWith('@search _q\n'))
      return mockResponse(200, { results: [{ ok: true, data: [] }] })
    })

    await client.query(`user\n  name\n`)
  })

  it('threads opts.op through (get mode)', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const op = JSON.parse(opts.body).operations[0]
      assert.equal(op.op, 'xsql')
      assert.ok(op.xsql.startsWith('@get _q\n'))
      assert.ok(op.xsql.includes('?xid:string'))
      return mockResponse(200, { results: [{ ok: true, data: { name: 'Alice' } }] })
    })

    const user = await client.query(
      `user (xid = ?xid:string)\n  name\n`,
      { xid: 'abc' },
      { op: 'get' }
    )
    assert.deepEqual(user, { name: 'Alice' })
  })

  it('omits :params when not provided', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const op = JSON.parse(opts.body).operations[0]
      assert.ok(!('params' in op), 'params should not be on the op when undefined')
      return mockResponse(200, { results: [{ ok: true, data: [] }] })
    })

    await client.query(`name\n`, undefined, { entity: 'User' })
  })

  it('passes actingAs through opts', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.acting_as, 'user-xid-1')
      return mockResponse(200, { results: [{ ok: true, data: [] }] })
    })

    await client.query(`name\n`, undefined,
      { entity: 'User', actingAs: 'user-xid-1' })
  })

  it('surfaces PARAM_MISSING errors as SynthigyError', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(200, {
        results: [{
          ok: false,
          error: { message: 'Missing value for parameter ?a', code: 'PARAM_MISSING' },
        }],
      })
    )

    await assert.rejects(
      () => client.query(`_args (active = ?a:boolean)\n\nname\n`, {},
                         { entity: 'User' }),
      (err) => err instanceof SynthigyError && err.code === 'PARAM_MISSING'
    )
  })

  it('surfaces XSQL parse diagnostics + source position', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const diags = [{ message: 'unexpected', from: 0, to: 1, start: { line: 1, col: 1 } }]

    mockFetch.mock.mockImplementation(async () =>
      mockResponse(200, {
        results: [{
          ok: false,
          error: { message: 'XSQL parse error', code: 'XSQL_PARSE_ERROR',
                   diagnostics: diags, line: 1, col: 1 },
        }],
      })
    )

    await assert.rejects(
      () => client.query(`bad syntax `, undefined, { entity: 'User' }),
      (err) => err instanceof SynthigyError &&
               err.code     === 'XSQL_PARSE_ERROR' &&
               err.category === 'validation' &&
               err.line     === 1 &&
               err.col      === 1 &&
               Array.isArray(err.diagnostics)
    )
  })
})

describe('lint', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('POSTs source to /lint and returns diagnostics', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const wire = [{
      severity: 'error', message: 'Unknown attribute', from: 0, to: 4,
      start: { line: 1, col: 1 }, end: { line: 1, col: 5 },
    }]

    mockFetch.mock.mockImplementation(async (url, opts) => {
      assert.equal(url, 'http://localhost/lint')
      assert.equal(opts.method, 'POST')
      const body = JSON.parse(opts.body)
      assert.equal(body.source, 'foo\n')
      assert.equal(body.entity, 'user')
      assert.equal(body.op, 'search')
      return mockResponse(200, { diagnostics: wire })
    })

    const diags = await client.lint('foo\n', { entity: 'user', op: 'search' })
    assert.deepEqual(diags, wire)
  })

  it('omits entity + op when not provided', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.source, 'name\n')
      assert.ok(!('entity' in body))
      assert.ok(!('op' in body))
      return mockResponse(200, { diagnostics: [] })
    })

    const diags = await client.lint('name\n')
    assert.deepEqual(diags, [])
  })

  it('returns empty array when response has no diagnostics field', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    mockFetch.mock.mockImplementation(async () => mockResponse(200, {}))
    assert.deepEqual(await client.lint('name\n'), [])
  })

  it('throws SynthigyError on HTTP error', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    mockFetch.mock.mockImplementation(async () =>
      mockResponse(400, { error: { message: 'bad body', code: 'INVALID_BODY' } })
    )
    await assert.rejects(
      () => client.lint(''),
      (err) => err instanceof SynthigyError && err.code === 'INVALID_BODY'
    )
  })
})

describe('onboard', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('POSTs to /oauth/onboard and returns the claim link', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      assert.equal(url, 'http://localhost/oauth/onboard')
      assert.equal(opts.method, 'POST')
      const body = JSON.parse(opts.body)
      assert.equal(body.xid, 'user-xid-1')
      assert.equal(body.reset, true)
      assert.deepEqual(body.methods, ['password'])
      assert.equal(body.ttl_seconds, 600)
      assert.equal(body.return_url, 'https://app.example.com/callback')
      return mockResponse(200, {
        onboard_url: 'http://x/oauth/claim?token=t', expires_at: 123,
        user: { xid: 'user-xid-1' },
      })
    })

    const out = await client.onboard('user-xid-1',
      { reset: true, methods: ['password'], ttlSeconds: 600,
        returnUrl: 'https://app.example.com/callback' })
    assert.equal(out.expires_at, 123)
    assert.equal(out.user.xid, 'user-xid-1')
  })

  it('omits reset/methods/ttlSeconds when not provided', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body, { xid: 'user-xid-1' })
      return mockResponse(200, { onboard_url: 'x', expires_at: 1 })
    })
    await client.onboard('user-xid-1')
  })

  it('maps a bare-string error code to SynthigyError (not the {code,message} shape)', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    mockFetch.mock.mockImplementation(async () =>
      mockResponse(403, { error: 'provision_forbidden' })
    )
    await assert.rejects(
      () => client.onboard('user-xid-1'),
      (err) => err instanceof SynthigyError && err.code === 'PROVISION_FORBIDDEN' &&
        err.category === 'auth' && err.status === 403
    )
  })

  it('maps user_not_found to an auth-category error', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    mockFetch.mock.mockImplementation(async () =>
      mockResponse(404, { error: 'user_not_found' })
    )
    await assert.rejects(
      () => client.onboard('does-not-exist'),
      (err) => err instanceof SynthigyError && err.code === 'USER_NOT_FOUND' &&
        err.category === 'auth' && err.status === 404
    )
  })

  it('does not crash on a non-JSON error body', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    mockFetch.mock.mockImplementation(async () => ({
      ok: false,
      status: 404,
      json: async () => { throw new SyntaxError('Unexpected token N in JSON') },
      text: async () => 'Not found',
    }))
    await assert.rejects(
      () => client.onboard('user-xid-1'),
      (err) => err instanceof SynthigyError && err.code === 'HTTP_ERROR' && err.status === 404
    )
  })
})

describe('onboardComplete', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('POSTs to /oauth/onboard/complete with only the ticket — never a credential', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      assert.equal(url, 'http://localhost/oauth/onboard/complete')
      assert.equal(opts.method, 'POST')
      const body = JSON.parse(opts.body)
      assert.deepEqual(body, { ticket: 'the-ticket' })
      return mockResponse(200, { user: { xid: 'user-xid-1' }, active: true })
    })

    const out = await client.onboardComplete('the-ticket')
    assert.equal(out.active, true)
    assert.equal(out.user.xid, 'user-xid-1')
  })

  it('maps claim_invalid (wrong client) to an auth-category error', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    mockFetch.mock.mockImplementation(async () =>
      mockResponse(400, { error: 'claim_invalid' })
    )
    await assert.rejects(
      () => client.onboardComplete('not-my-ticket'),
      (err) => err instanceof SynthigyError && err.code === 'CLAIM_INVALID' &&
        err.category === 'auth' && err.status === 400
    )
  })
})

describe('history', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('getAt POSTs to /history with op:get-at and kebab-case keys', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      assert.equal(url, 'http://localhost/history')
      assert.equal(opts.method, 'POST')
      const body = JSON.parse(opts.body)
      assert.equal(body.op, 'get-at')
      assert.deepEqual(body.opts, {
        'record-xid': 'xid-1',
        at: '2026-01-01T00:00:00Z',
      })
      return mockResponse(200, { op: 'get-at', result: { name: 'Alice' } })
    })

    const result = await client.history.getAt('xid-1', '2026-01-01T00:00:00Z')
    assert.deepEqual(result, { name: 'Alice' })
  })

  it('getAt passes includeDeleted as include-deleted? (Clojure keyword)', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.opts['include-deleted?'], true)
      return mockResponse(200, { op: 'get-at', result: null })
    })

    await client.history.getAt('xid-1', '2026-01-01T00:00:00Z',
      { includeDeleted: true })
  })

  it('events POSTs with record-xid + between + track', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.op, 'events')
      assert.deepEqual(body.opts, {
        'record-xid': 'xid-1',
        between: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'],
        limit: 50,
        track: 'entity',
      })
      return mockResponse(200, { op: 'events', result: [] })
    })

    const events = await client.history.events({
      recordXid: 'xid-1',
      between: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'],
      limit: 50,
      track: 'entity',
    })
    assert.deepEqual(events, [])
  })

  it('diff POSTs with from-ts and to-ts kebab keys', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      assert.deepEqual(body.opts, {
        'record-xid': 'xid-1',
        'from-ts': 't1',
        'to-ts': 't2',
      })
      return mockResponse(200, {
        op: 'diff',
        result: { before: { x: 1 }, after: { x: 2 }, changed: ['x'] },
      })
    })

    const diff = await client.history.diff('xid-1', 't1', 't2')
    assert.deepEqual(diff.changed, ['x'])
  })

  it('timeline POSTs with group-by kebab key', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.op, 'timeline')
      assert.equal(body.opts['group-by'], 'actor')
      return mockResponse(200, { op: 'timeline', result: {} })
    })

    await client.history.timeline({
      between: ['t1', 't2'],
      groupBy: 'actor',
    })
  })

  it('since POSTs with cursor and track', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.op, 'since')
      assert.deepEqual(body.opts, { cursor: 't1', track: 'relation', limit: 25 })
      return mockResponse(200, { op: 'since', result: [] })
    })

    await client.history.since({ cursor: 't1', track: 'relation', limit: 25 })
  })

  it('throws HISTORY_UNAVAILABLE on 404', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    mockFetch.mock.mockImplementation(async () =>
      mockResponse(404, { error: { message: 'No audit provider', code: 'HISTORY_UNAVAILABLE' } })
    )

    await assert.rejects(
      () => client.history.events(),
      (err) => err instanceof SynthigyError && err.code === 'HISTORY_UNAVAILABLE',
    )
  })

  it('throws SynthigyError with code on 4xx error response', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    mockFetch.mock.mockImplementation(async () =>
      mockResponse(400, { error: { message: 'record-xid is required', code: 'RECORD_XID_REQUIRED' } })
    )

    await assert.rejects(
      () => client.history.getAt(undefined, 't1'),
      (err) => err instanceof SynthigyError && err.code === 'RECORD_XID_REQUIRED',
    )
  })
})

describe('listen', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  function sseReader(text) {
    const encoded = new TextEncoder().encode(text)
    let sent = false
    return {
      getReader() {
        return {
          async read() {
            if (!sent) { sent = true; return { done: false, value: encoded } }
            return { done: true, value: undefined }
          },
        }
      },
    }
  }

  it('yields the real /data/events delta envelopes verbatim', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac = new AbortController()

    // GROUND TRUTH: these are the exact frame shapes the live server emits on
    // /data/events (captured from a running server). Records are FAT
    // (type:"record/*", record-xid, before/after — snake_case attr names);
    // relations are THIN (type:"relation/*", data:[subscribed, other]). There
    // is NO entity name and NO `element` field on the wire. SSE event is "data".
    const sseText =
      'event: data\ndata: {"type":"record/insert","record-xid":"u-1","ts":"2026-05-24T00:00:01Z","txid":1,"actor":"a-1","after":{"name":"Alice","release_year":1995}}\n\n' +
      'event: data\ndata: {"type":"record/delete","record-xid":"r-1","ts":"2026-05-24T00:00:02Z","txid":2,"actor":"a-1","before":{"name":"Admin"}}\n\n' +
      'event: data\ndata: {"type":"relation/link","data":["u-1","m-9"],"ts":"2026-05-24T00:00:03Z","txid":3,"actor":"a-1"}\n\n'

    mockFetch.mock.mockImplementation(async (url, opts) => {
      assert.equal(url, 'http://localhost/data/events')
      assert.equal(opts.headers['Authorization'], 'Bearer t')
      const body = sseReader(sseText)
      const origGetReader = body.getReader.bind(body)
      body.getReader = () => {
        const r = origGetReader()
        const origRead = r.read.bind(r)
        r.read = async () => {
          const chunk = await origRead()
          if (chunk.done) ac.abort()
          return chunk
        }
        return r
      }
      return { ok: true, status: 200, body }
    })

    const events = []
    for await (const event of client.listen({ signal: ac.signal })) {
      // Skip the internal SSE-handshake sentinel; the test cares about
      // delta envelopes only.
      if (event.type === 'sse/open') continue
      events.push(event)
    }

    assert.equal(events.length, 3)
    // record/insert — fat, after only, keyed by record-xid
    assert.equal(events[0].type, 'record/insert')
    assert.equal(events[0]['record-xid'], 'u-1')
    assert.deepEqual(events[0].after, { name: 'Alice', release_year: 1995 })
    assert.equal(events[0].entity, undefined, 'server never sends an entity name')
    assert.equal(events[0].element, undefined, 'no `element` field on the wire')
    // record/delete — fat, before only
    assert.equal(events[1].type, 'record/delete')
    assert.equal(events[1]['record-xid'], 'r-1')
    assert.deepEqual(events[1].before, { name: 'Admin' })
    // relation/link — thin tuple [subscribed, other]
    assert.equal(events[2].type, 'relation/link')
    assert.deepEqual(events[2].data, ['u-1', 'm-9'])
    assert.equal(events[2]['record-xid'], undefined, 'relations carry no record-xid')
  })

  it('sends Last-Event-ID on reconnect', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac = new AbortController()
    let callCount = 0

    mockFetch.mock.mockImplementation(async (url, opts) => {
      callCount++
      if (callCount === 1) {
        assert.equal(opts.headers['Last-Event-ID'], undefined)
        const sseText =
          'id: 42\nevent: data\ndata: {"type":"record/insert","record-xid":"u-1","ts":"t1","txid":42}\n\n'
        return { ok: true, status: 200, body: sseReader(sseText) }
      }
      assert.equal(opts.headers['Last-Event-ID'], '42')
      ac.abort()
      return { ok: true, status: 200, body: sseReader('') }
    })

    const events = []
    for await (const event of client.listen({ signal: ac.signal })) {
      if (event.type === 'sse/open') continue
      events.push(event)
    }

    assert.equal(callCount, 2)
    assert.equal(events.length, 1)
    assert.equal(events[0]['record-xid'], 'u-1')
  })

  it('stops immediately when signal is already aborted', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac = new AbortController()
    ac.abort()

    const events = []
    for await (const event of client.listen({ signal: ac.signal })) {
      events.push(event)
    }

    assert.equal(mockFetch.mock.calls.length, 0)
    assert.equal(events.length, 0)
  })
})

describe('observe', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  function sseReader(text) {
    const encoded = new TextEncoder().encode(text)
    let sent = false
    return {
      getReader() {
        return {
          async read() {
            if (!sent) { sent = true; return { done: false, value: encoded } }
            return { done: true, value: undefined }
          },
          cancel: () => {},
        }
      },
    }
  }

  // Helper: build a fetch mock that:
  //   - returns 200 ok-true to /data/subscription/set POSTs
  //   - returns one SSE stream of `sseText` for /data/events GETs
  //   - aborts `ac` once the SSE stream closes so the reconnect loop exits
  //   - records each request body so the test can assert on subscribe content
  function setupSseHarness(ac, sseText) {
    const subscribeBodies = []
    mockFetch.mock.mockImplementation(async (url, opts) => {
      if (url === 'http://localhost/data/subscription/set') {
        subscribeBodies.push(JSON.parse(opts.body))
        return mockResponse(200, { ok: true })
      }
      if (url === 'http://localhost/data/events') {
        const body = sseReader(sseText)
        const origGetReader = body.getReader.bind(body)
        body.getReader = () => {
          const r = origGetReader()
          const origRead = r.read.bind(r)
          r.read = async () => {
            const chunk = await origRead()
            if (chunk.done) ac.abort()
            return chunk
          }
          return r
        }
        return { ok: true, status: 200, body, text: async () => '' }
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    return subscribeBodies
  }

  it('subscribes a record-set then yields events matching record-xid', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac = new AbortController()
    // u-1 and u-2 are in the watch set; r-1 is not.
    const sseText =
      'event: data\ndata: {"type":"record/update","record-xid":"u-1","ts":"2026-05-24T00:00:01Z","before":{"name":"A"},"after":{"name":"B"},"actor":"actor-1","txid":7}\n\n' +
      'event: data\ndata: {"type":"record/delete","record-xid":"r-1","ts":"2026-05-24T00:00:02Z","before":{"name":"Admin"}}\n\n' +
      'event: data\ndata: {"type":"record/insert","record-xid":"u-2","ts":"2026-05-24T00:00:03Z","after":{"name":"Carol"}}\n\n'

    const subs = setupSseHarness(ac, sseText)

    const events = []
    for await (const ev of client.observe(['u-1', 'u-2'], { signal: ac.signal })) {
      events.push(ev)
    }

    // r-1 filtered out by the SDK's defense-in-depth match (server
    // wouldn't have sent it in production, but we want the SDK to
    // gate the same way for parallel observe()s on one client).
    assert.equal(events.length, 2, `events: ${JSON.stringify(events)}`)
    assert.equal(events[0].type, 'record/update')
    assert.equal(events[0]['record-xid'], 'u-1')
    assert.deepEqual(events[0].before, { name: 'A' })
    assert.deepEqual(events[0].after, { name: 'B' })
    assert.equal(events[0].actor, 'actor-1')
    assert.equal(events[0].txid, 7)
    assert.equal(events[1].type, 'record/insert')
    assert.deepEqual(events[1].after, { name: 'Carol' })
    // First POST sets the record-scoped subscription; final POST (on cleanup) is empty.
    assert.deepEqual(subs[0], {
      subscriptions: [{ type: 'data', records: ['u-1', 'u-2'] }],
    })
    assert.deepEqual(subs[subs.length - 1].subscriptions, [])
  })

  it('passes operations through into the subscription item', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac = new AbortController()
    const subs = setupSseHarness(ac, '')

    const events = []
    for await (const ev of client.observe(
      { records: ['u-1'], operations: ['change'] },
      { signal: ac.signal })) {
      events.push(ev)
    }

    assert.deepEqual(subs[0].subscriptions, [{
      type: 'data', records: ['u-1'], operations: ['change'],
    }])
  })

  it('yields relation events when either endpoint matches the watch set', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac = new AbortController()
    // u-1 is the watched xid. Server has rotated `data` so position 0 is
    // always the subscribed endpoint:
    //   first link  — u-1 was from-side  → data: [u-1, role-1]
    //   second link — u-1 was to-side    → data: [u-1, team-x]
    //   third link  — neither endpoint matches the watch set → filtered.
    const sseText =
      'event: data\ndata: {"type":"relation/link","data":["u-1","role-1"],"ts":"2026-05-24T00:00:01Z","actor":"a","txid":9}\n\n' +
      'event: data\ndata: {"type":"relation/link","data":["u-1","team-x"],"ts":"2026-05-24T00:00:02Z","actor":"a","txid":10}\n\n' +
      'event: data\ndata: {"type":"relation/link","data":["y-1","y-2"],"ts":"2026-05-24T00:00:03Z","actor":"a","txid":11}\n\n'
    setupSseHarness(ac, sseText)

    const events = []
    for await (const ev of client.observe(['u-1'], { signal: ac.signal })) {
      events.push(ev)
    }

    assert.equal(events.length, 2)
    assert.equal(events[0].data[0], 'u-1')
    assert.equal(events[1].data[0], 'u-1')
  })

  it('unsubscribes on iterator close (cleanup runs)', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac = new AbortController()
    const sseText =
      'event: data\ndata: {"type":"record/insert","record-xid":"u-1","ts":"t1","after":{}}\n\n'
    const subs = setupSseHarness(ac, sseText)

    for await (const _ev of client.observe(['u-1'], { signal: ac.signal })) {
      // Single-iteration consumer; SSE ends and aborts.
    }

    // Verify the final POST cleared this descriptor.
    const last = subs[subs.length - 1]
    assert.deepEqual(last.subscriptions, [],
      `Expected descriptor removed from final set: ${JSON.stringify(last)}`)
  })

  it('stops immediately when signal is already aborted', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac = new AbortController()
    ac.abort()

    const events = []
    for await (const ev of client.observe(['u-1'], { signal: ac.signal })) {
      events.push(ev)
    }

    assert.equal(events.length, 0)
    assert.equal(mockFetch.mock.calls.length, 0)
  })

  it('backfill: false (default) does not call /history', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac = new AbortController()
    const sseText =
      'event: data\ndata: {"type":"record/insert","record-xid":"u-1","ts":"2026-05-24T00:00:01Z","after":{}}\n\n'

    const calls = []
    mockFetch.mock.mockImplementation(async (url, _opts) => {
      calls.push(url)
      if (url === 'http://localhost/data/subscription/set') {
        return mockResponse(200, { ok: true })
      }
      if (url === 'http://localhost/data/events') {
        const body = sseReader(sseText)
        const origGetReader = body.getReader.bind(body)
        body.getReader = () => {
          const r = origGetReader()
          const origRead = r.read.bind(r)
          r.read = async () => {
            const chunk = await origRead()
            if (chunk.done) ac.abort()
            return chunk
          }
          return r
        }
        return { ok: true, status: 200, body, text: async () => '' }
      }
      throw new Error(`unexpected ${url}`)
    })

    for await (const _ of client.observe(['u-1'], { signal: ac.signal })) { /* drain */ }

    assert.ok(!calls.includes('http://localhost/history'),
      'should not hit /history when backfill is off')
  })

  it('backfill: true folds /history rows into channel-shaped events for watched records', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac = new AbortController()
    const sseText =
      'event: data\ndata: {"type":"record/update","record-xid":"u-1","ts":"2026-05-24T00:00:01Z","before":{"name":"A"},"after":{"name":"B"}}\n\n'

    let historyCallCount = 0
    mockFetch.mock.mockImplementation(async (url, opts) => {
      if (url === 'http://localhost/data/subscription/set') {
        return mockResponse(200, { ok: true })
      }
      if (url === 'http://localhost/data/events') {
        return { ok: true, status: 200, body: sseReader(sseText), text: async () => '' }
      }
      if (url === 'http://localhost/history') {
        historyCallCount++
        const reqBody = JSON.parse(opts.body)
        assert.equal(reqBody.op, 'events')
        assert.equal(reqBody.opts.between[0], '2026-05-24T00:00:01Z')
        ac.abort()
        // Attribute-primary rows: two attrs for u-1 update, one row for u-2
        // (outside the watch set — should be filtered).
        return mockResponse(200, { op: 'events', result: [
          { ts: '2026-05-24T00:00:02Z', 'record-xid': 'u-1', op: 'update',
            'attribute-xid': 'name-xid', value: 'NewName', 'actor-xid': 'a1' },
          { ts: '2026-05-24T00:00:02Z', 'record-xid': 'u-1', op: 'update',
            'attribute-xid': 'email-xid', value: 'new@x', 'actor-xid': 'a1' },
          { ts: '2026-05-24T00:00:04Z', 'record-xid': 'u-2', op: 'delete' },
        ]})
      }
      throw new Error(`unexpected ${url}`)
    })

    const events = []
    for await (const ev of client.observe(['u-1'],
        { signal: ac.signal, backfill: true })) {
      events.push(ev)
    }

    assert.equal(historyCallCount, 1)
    // 1 live + 1 backfill (u-1 update folded across attrs). u-2 is filtered out.
    assert.equal(events.length, 2, `events: ${JSON.stringify(events, null, 2)}`)
    // Live event: record-shaped envelope, no fromBackfill flag.
    assert.equal(events[0].type, 'record/update')
    assert.equal(events[0]['record-xid'], 'u-1')
    assert.ok(!events[0].fromBackfill)
    // Backfill u-1: update folded across two attribute rows. Backfill keeps
    // attribute-xid keys (history is attribute-primary; the live path has
    // attribute-key translation, this one does not — `fromBackfill` flags it).
    assert.equal(events[1].fromBackfill, true)
    assert.equal(events[1].type, 'record/update')
    assert.equal(events[1]['record-xid'], 'u-1')
    assert.deepEqual(events[1].after, { 'name-xid': 'NewName', 'email-xid': 'new@x' })
    assert.equal(events[1].actor, 'a1')
  })

  it('backfill: true tolerates HISTORY_UNAVAILABLE silently', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac = new AbortController()
    const sseText =
      'event: data\ndata: {"type":"record/insert","record-xid":"u-1","ts":"t1","after":{}}\n\n'

    mockFetch.mock.mockImplementation(async (url) => {
      if (url === 'http://localhost/data/subscription/set') {
        return mockResponse(200, { ok: true })
      }
      if (url === 'http://localhost/data/events') {
        return { ok: true, status: 200, body: sseReader(sseText), text: async () => '' }
      }
      if (url === 'http://localhost/history') {
        ac.abort()
        return mockResponse(404, { error: { message: 'No audit provider', code: 'HISTORY_UNAVAILABLE' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const events = []
    for await (const ev of client.observe(['u-1'],
        { signal: ac.signal, backfill: true })) {
      events.push(ev)
    }

    // The live event came through; backfill failed silently.
    assert.equal(events.length, 1)
    assert.equal(events[0].fromBackfill, undefined)
  })

  it('two parallel observe()s on one client coexist and each gets only its records', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const ac1 = new AbortController()
    const ac2 = new AbortController()
    // Each session yields the same stream; the SDK filters per descriptor.
    const sseText =
      'event: data\ndata: {"type":"record/update","record-xid":"u-1","ts":"t1","after":{"x":1}}\n\n' +
      'event: data\ndata: {"type":"record/update","record-xid":"u-2","ts":"t2","after":{"x":2}}\n\n'

    const bodies = []
    mockFetch.mock.mockImplementation(async (url, opts) => {
      if (url === 'http://localhost/data/subscription/set') {
        bodies.push(JSON.parse(opts.body))
        return mockResponse(200, { ok: true })
      }
      if (url === 'http://localhost/data/events') {
        const body = sseReader(sseText)
        const origGetReader = body.getReader.bind(body)
        body.getReader = () => {
          const r = origGetReader()
          const origRead = r.read.bind(r)
          r.read = async () => {
            const chunk = await origRead()
            if (chunk.done) { ac1.abort(); ac2.abort() }
            return chunk
          }
          return r
        }
        return { ok: true, status: 200, body, text: async () => '' }
      }
      throw new Error(`unexpected ${url}`)
    })

    const a = []
    const b = []
    async function drain(iter, into) { for await (const ev of iter) into.push(ev) }
    await Promise.all([
      drain(client.observe(['u-1'], { signal: ac1.signal, key: 'a' }), a),
      drain(client.observe(['u-2'], { signal: ac2.signal, key: 'b' }), b),
    ])

    assert.equal(a.length, 1, `a: ${JSON.stringify(a)}`)
    assert.equal(a[0]['record-xid'], 'u-1')
    assert.equal(b.length, 1, `b: ${JSON.stringify(b)}`)
    assert.equal(b[0]['record-xid'], 'u-2')

    // At some point the wire body included both descriptors. The final
    // body is empty (both observers cleaned up).
    const everSawBoth = bodies.some(body =>
      body.subscriptions.length === 2 &&
      body.subscriptions.every(s => s.type === 'data'))
    assert.ok(everSawBoth,
      `expected at least one body with both descriptors: ${JSON.stringify(bodies)}`)
  })
})

describe('401 retry', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('clears token cache and retries once on 401', async () => {
    const client = createClient({
      endpoint: 'http://localhost',
      clientId: 'c',
      clientSecret: 's',
    })

    let callCount = 0
    mockFetch.mock.mockImplementation(async (url) => {
      callCount++
      if (url.includes('/oauth/token')) {
        return mockResponse(200, { access_token: `tok-${callCount}`, expires_in: 3600 })
      }
      // call 2: /data → 401; call 4: /data → ok
      if (callCount === 2) return mockResponse(401, {})
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, ['name'])
    // 1: /oauth/token, 2: /data (401), 3: /oauth/token (after cache clear), 4: /data (ok)
    assert.equal(callCount, 4)
  })

  it('throws UNAUTHORIZED if retry also returns 401', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 'bad' })

    mockFetch.mock.mockImplementation(async () => mockResponse(401, {}))

    await assert.rejects(
      () => client.search('User', {}, ['name']),
      (err) => err instanceof SynthigyError && err.code === 'UNAUTHORIZED'
    )
  })
})

describe('keyFormat', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('sends key_format from per-call opts', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.key_format, 'kebab')
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, ['name'], { keyFormat: 'kebab' })
  })

  it('uses client-level keyFormat as default', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't', keyFormat: 'snake' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.key_format, 'snake')
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, ['name'])
  })

  it('per-call keyFormat overrides client default', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't', keyFormat: 'snake' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.key_format, 'camel')
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, ['name'], { keyFormat: 'camel' })
  })
})

describe('defaultActingAs', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('applies client-level actingAs to every request', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't', actingAs: 'u-default' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.acting_as, 'u-default')
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, ['name'])
  })

  it('per-call actingAs overrides client default', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't', actingAs: 'u-default' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body)
      assert.equal(body.acting_as, 'u-override')
      return mockResponse(200, { results: [{ data: [], ok: true }] })
    })

    await client.search('User', {}, ['name'], { actingAs: 'u-override' })
  })
})

describe('token method', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('returns static token directly', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 'my-static-token' })
    assert.equal(await client.token(), 'my-static-token')
  })

  it('static token ignores audience', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 'my-static-token' })
    assert.equal(await client.token({ audience: 'robotics' }), 'my-static-token')
  })

  it('client credentials fetches token for audience', async () => {
    const client = createClient({ endpoint: 'http://localhost', clientId: 'c', clientSecret: 's' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      assert.ok(opts.body.toString().includes('audience=robotics'))
      return mockResponse(200, { access_token: 'robotics-token', expires_in: 3600 })
    })

    assert.equal(await client.token({ audience: 'robotics' }), 'robotics-token')
  })

  it('caches token and avoids redundant requests', async () => {
    const client = createClient({ endpoint: 'http://localhost', clientId: 'c', clientSecret: 's' })
    let tokenCalls = 0

    mockFetch.mock.mockImplementation(async () => {
      tokenCalls++
      return mockResponse(200, { access_token: 'cached-token', expires_in: 3600 })
    })

    assert.equal(await client.token(), 'cached-token')
    assert.equal(await client.token(), 'cached-token')
    assert.equal(tokenCalls, 1)
  })
})

describe('fetchFn', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('returns a function that POSTs to /data with auth', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })

    mockFetch.mock.mockImplementation(async (url, opts) => {
      assert.equal(url, 'http://localhost/data')
      assert.equal(opts.headers['Authorization'], 'Bearer t')
      return mockResponse(200, { results: [{ data: [{ name: 'Alice' }], ok: true }] })
    })

    const fn = client.fetchFn()
    const result = await fn({ operations: [{ op: 'search', entity: 'User', args: {}, selections: { name: null } }] })
    assert.deepEqual(result.results[0].data, [{ name: 'Alice' }])
  })
})

describe('remaining operators', () => {
  it('neq builds _neq', () => assert.deepEqual(neq(5), { _neq: 5 }))
  it('gte builds _ge', () => assert.deepEqual(gte(5), { _ge: 5 }))
  it('lt builds _lt', () => assert.deepEqual(lt(5), { _lt: 5 }))
  it('lte builds _le', () => assert.deepEqual(lte(5), { _le: 5 }))
  it('nin builds _nin', () => assert.deepEqual(nin(1, 2, 3), { _nin: [1, 2, 3] }))
  it('ilike builds _ilike', () => assert.deepEqual(ilike('%test%'), { _ilike: '%test%' }))
  it('isNotNull builds _is_not_null: true', () => assert.deepEqual(isNotNull(), { _is_not_null: true }))
  it('in_ flattens array arg', () => assert.deepEqual(in_([1, 2, 3]), { _in: [1, 2, 3] }))
  it('nin flattens array arg', () => assert.deepEqual(nin([1, 2, 3]), { _nin: [1, 2, 3] }))
})

describe('op builders', () => {
  it('op.search', () => {
    assert.deepEqual(op.search('User', { active: eq(true) }, { name: null }), {
      op: 'search', entity: 'User', args: { active: { _eq: true } }, selections: { name: null },
    })
  })

  it('op.get', () => {
    assert.deepEqual(op.get('User', { xid: 'u-1' }, { name: null }), {
      op: 'get', entity: 'User', args: { xid: 'u-1' }, selections: { name: null },
    })
  })

  it('op.sync', () => {
    assert.deepEqual(op.sync('User', { xid: 'u-1', name: 'Alice' }), {
      op: 'sync', entity: 'User', data: { xid: 'u-1', name: 'Alice' },
      returning: false,
    })
    assert.deepEqual(op.sync('User', { name: 'Alice' }, true), {
      op: 'sync', entity: 'User', data: { name: 'Alice' }, returning: true,
    })
  })

  it('op.stack', () => {
    assert.deepEqual(op.stack('User', { xid: 'u-1', roles: [{ xid: 'r-1' }] }), {
      op: 'stack', entity: 'User', data: { xid: 'u-1', roles: [{ xid: 'r-1' }] },
      returning: false,
    })
  })

  it('op.slice', () => {
    const o = op.slice('User', { xid: 'u-1', roles: [{ xid: 'r-1' }] })
    assert.equal(o.op, 'slice')
    assert.equal(o.entity, 'User')
    assert.deepEqual(o.args, { xid: 'u-1', roles: [{ xid: 'r-1' }] })
  })

  it('op.delete', () => {
    assert.deepEqual(op.delete('User', { xid: 'u-1' }), {
      op: 'delete', entity: 'User', data: { xid: 'u-1' },
    })
  })

  it('op.purge', () => {
    const o = op.purge('User', { active: eq(false) })
    assert.equal(o.op, 'purge')
    assert.deepEqual(o.args, { active: { _eq: false } })
  })

  it('op.searchTree', () => {
    assert.deepEqual(op.searchTree('Dept', 'parent', { _limit: 10 }, { name: null }), {
      op: 'search-tree', entity: 'Dept', on: 'parent', args: { _limit: 10 }, selections: { name: null },
    })
  })

  it('op.getTree', () => {
    assert.deepEqual(op.getTree('Dept', 'root-id', 'parent', { name: null }), {
      op: 'get-tree', entity: 'Dept', root: 'root-id', on: 'parent', selections: { name: null },
    })
  })

  it('op.sqlTemplate', () => {
    assert.deepEqual(op.sqlTemplate('SELECT 1', [42]), {
      op: 'sql-template', template: 'SELECT 1', params: [42],
    })
  })
})

// ============================================================================
// schema
// ============================================================================

describe('schema', () => {
  beforeEach(() => mockFetch.mock.resetCalls())

  it('fetches schema via GET /schema', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    const fixture = {
      'id-key': 'xid',
      entities: {
        user: { name: 'User', attributes: { name: 'string' }, relations: {}, constraints: { unique: [['xid']] } }
      }
    }
    mockFetch.mock.mockImplementation(async (url, opts) => {
      assert.equal(url, 'http://localhost/schema')
      assert.ok(!opts?.method || opts.method === 'GET')
      return mockResponse(200, fixture)
    })
    const schema = await client.schema()
    assert.equal(schema['id-key'], 'xid')
    assert.ok('user' in schema.entities)
  })

  it('appends ?entities query param when filtering', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    mockFetch.mock.mockImplementation(async (url) => {
      assert.ok(url.includes('entities=user%2Chuman') || url.includes('entities=user,human'), `unexpected url: ${url}`)
      return mockResponse(200, { 'id-key': 'xid', entities: {} })
    })
    await client.schema(['user', 'human'])
  })

  it('throws SynthigyError on 401', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 'bad' })
    mockFetch.mock.mockImplementation(async () =>
      mockResponse(401, { error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } })
    )
    await assert.rejects(
      () => client.schema(),
      (err) => err instanceof SynthigyError && err.code === 'UNAUTHORIZED'
    )
  })
})

// ============================================================================
// composeTree / composeForest
// ============================================================================

describe('composeTree', () => {
  const flat = [
    { xid: 'a', name: 'root', parent: null },
    { xid: 'b', name: 'child1', parent: { xid: 'a' } },
    { xid: 'c', name: 'child2', parent: { xid: 'a' } },
    { xid: 'd', name: 'grandchild', parent: { xid: 'b' } },
  ]

  it('builds a nested tree from flat records', () => {
    const tree = composeTree(flat, { on: 'parent', rootId: 'a' })
    assert.equal(tree.xid, 'a')
    assert.equal(tree._children.length, 2)
    const b = tree._children.find(c => c.xid === 'b')
    assert.ok(b)
    assert.equal(b._children.length, 1)
    assert.equal(b._children[0].xid, 'd')
  })

  it('uses first record as root when rootId omitted', () => {
    const tree = composeTree(flat, { on: 'parent' })
    assert.equal(tree.xid, 'a')
  })

  it('returns null when rootId not found', () => {
    assert.equal(composeTree(flat, { on: 'parent', rootId: 'missing' }), null)
  })

  it('returns null for empty array', () => {
    assert.equal(composeTree([], { on: 'parent' }), null)
  })

  it('throws when on is omitted', () => {
    assert.throws(() => composeTree(flat, {}), /`on`/)
  })

  it('respects custom childrenKey', () => {
    const tree = composeTree(flat, { on: 'parent', rootId: 'a', childrenKey: 'kids' })
    assert.ok('kids' in tree)
    assert.equal(tree.kids.length, 2)
  })

  it('handles parent as plain id string (not object)', () => {
    const records = [
      { xid: 'x', parent: null },
      { xid: 'y', parent: 'x' },
    ]
    const tree = composeTree(records, { on: 'parent', rootId: 'x' })
    assert.equal(tree._children[0].xid, 'y')
  })

  it('handles snake_case variant of relation key', () => {
    const records = [
      { xid: 'x', parent_node: null },
      { xid: 'y', parent_node: { xid: 'x' } },
    ]
    const tree = composeTree(records, { on: 'parent-node', rootId: 'x' })
    assert.equal(tree._children[0].xid, 'y')
  })

  it('breaks cycles — does not hang or throw', () => {
    // Cycle: a→b→a (simulated via flat records with circular references)
    const cyclic = [
      { xid: 'a', parent: { xid: 'b' } },
      { xid: 'b', parent: { xid: 'a' } },
    ]
    // Should not throw or infinite-loop
    const tree = composeTree(cyclic, { on: 'parent', rootId: 'a' })
    assert.ok(tree !== undefined)
  })
})

describe('composeForest', () => {
  const flat = [
    { xid: 'a', parent: null },
    { xid: 'b', parent: { xid: 'a' } },
    { xid: 'c', parent: null },
    { xid: 'd', parent: { xid: 'c' } },
  ]

  it('returns multiple root trees', () => {
    const forest = composeForest(flat, { on: 'parent' })
    assert.equal(forest.length, 2)
    const roots = forest.map(t => t.xid).sort()
    assert.deepEqual(roots, ['a', 'c'])
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(composeForest([], { on: 'parent' }), [])
  })

  it('throws when on is omitted', () => {
    assert.throws(() => composeForest(flat, {}), /`on`/)
  })

  it('treats record whose parent is not in the set as a root', () => {
    const records = [
      { xid: 'x', parent: { xid: 'missing' } },
      { xid: 'y', parent: { xid: 'x' } },
    ]
    const forest = composeForest(records, { on: 'parent' })
    assert.equal(forest.length, 1)
    assert.equal(forest[0].xid, 'x')
  })
})

// ============================================================================
// Safe teardown — no unhandled rejection when watchSqlTemplate/watchQuery
// bootstrap fails and the caller never awaits ready()
// ============================================================================

describe('safe watch teardown', () => {
  it('watchSqlTemplate bootstrap failure does not unhandled-reject', async () => {
    // Trap any unhandled rejection that fires during this test.
    let leaked = null
    const trap = (reason) => { leaked = reason }
    process.on('unhandledRejection', trap)
    try {
      const client = createClient({ endpoint: 'http://localhost', token: 't' })
      // Force sqlTemplate to reject — proxies the bootstrap error path.
      client.sqlTemplate = async () => { throw new Error('boom') }
      const w = client.watchSqlTemplate('SELECT 1', {}, { entities: ['X'] })
      // Caller deliberately does NOT await w.ready(). Before the fix
      // this would surface as an unhandled rejection.
      // Give the microtask queue a few ticks to settle.
      await new Promise((r) => setTimeout(r, 20))
      w.close()
      await new Promise((r) => setTimeout(r, 5))
      assert.equal(leaked, null,
        `unhandled rejection leaked: ${leaked?.message ?? leaked}`)
    } finally {
      process.off('unhandledRejection', trap)
    }
  })

  it('ready() still surfaces bootstrap error when awaited', async () => {
    const client = createClient({ endpoint: 'http://localhost', token: 't' })
    client.sqlTemplate = async () => { throw new Error('boom') }
    const w = client.watchSqlTemplate('SELECT 1', {}, { entities: ['X'] })
    await assert.rejects(() => w.ready(), /boom/)
    w.close()
  })
})
