import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { composeTree, composeForest } from '../src/index.js'

// Sample family used throughout — Howard Sr is root, 3 generations deep.
const family = [
  { xid: 'howard', first_name: 'Howard', father: {} },
  { xid: 'mary',   first_name: 'Mary',   father: { xid: 'howard' } },
  { xid: 'rich',   first_name: 'Richard', father: { xid: 'howard' } },
  { xid: 'ben',    first_name: 'Ben',    father: { xid: 'rich' } },
  { xid: 'pete',   first_name: 'Peter',  father: { xid: 'rich' } },
  { xid: 'may',    first_name: 'May',    father: { xid: 'rich' } },
]

describe('composeTree', () => {
  it('nests 3 generations under the root', () => {
    const tree = composeTree(family, { on: 'father', rootId: 'howard' })
    assert.equal(tree.xid, 'howard')
    assert.equal(tree._children.length, 2)
    const richard = tree._children.find(c => c.xid === 'rich')
    assert.equal(richard._children.length, 3)
    assert.deepEqual(
      richard._children.map(c => c.xid).sort(),
      ['ben', 'may', 'pete']
    )
  })

  it('defaults rootId to first record when omitted', () => {
    const tree = composeTree(family, { on: 'father' })
    assert.equal(tree.xid, 'howard')
  })

  it('returns null for empty input', () => {
    assert.equal(composeTree([], { on: 'father' }), null)
    assert.equal(composeTree(null, { on: 'father' }), null)
  })

  it('returns null when rootId is not in the record set', () => {
    assert.equal(composeTree(family, { on: 'father', rootId: 'ghost' }), null)
  })

  it('handles a single-record input', () => {
    const tree = composeTree([{ xid: 'alone', first_name: 'Solo', father: {} }],
      { on: 'father' })
    assert.equal(tree.xid, 'alone')
    assert.deepEqual(tree._children, [])
  })

  it('throws when :on is missing', () => {
    assert.throws(() => composeTree(family, {}), /on.*required/)
  })

  it('accepts a bare parent id (not a nested map)', () => {
    const flat = [
      { xid: 'a', father: null },
      { xid: 'b', father: 'a' },
      { xid: 'c', father: 'b' },
    ]
    const tree = composeTree(flat, { on: 'father', rootId: 'a' })
    assert.equal(tree._children[0].xid, 'b')
    assert.equal(tree._children[0]._children[0].xid, 'c')
  })

  it('uses kebab/snake variants of :on', () => {
    const flat = [
      { xid: 'a', 'parent-ref': null },
      { xid: 'b', 'parent-ref': { xid: 'a' } },
    ]
    // Ask with snake; records carry kebab — should still link
    const tree = composeTree(flat, { on: 'parent_ref', rootId: 'a' })
    assert.equal(tree._children[0].xid, 'b')
  })

  it('uses a custom childrenKey when requested', () => {
    const tree = composeTree(family,
      { on: 'father', rootId: 'howard', childrenKey: 'descendants' })
    assert.ok(Array.isArray(tree.descendants))
    assert.equal(tree._children, undefined)
  })

  it('survives a direct self-cycle without infinite recursion', () => {
    const flat = [
      { xid: 'a', father: { xid: 'a' } },
      { xid: 'b', father: { xid: 'a' } },
    ]
    // The a→a self-loop is filtered (id !== parentId guard on the edge),
    // so `a` is root, and b is a normal child.
    const tree = composeTree(flat, { on: 'father', rootId: 'a' })
    assert.equal(tree.xid, 'a')
    assert.equal(tree._children.length, 1)
    assert.equal(tree._children[0].xid, 'b')
  })

  it('survives a transitive cycle (a→b→a) without infinite recursion', () => {
    const flat = [
      { xid: 'a', father: { xid: 'b' } },
      { xid: 'b', father: { xid: 'a' } },
    ]
    // a says parent=b, b says parent=a — recursion breaks via visited-set.
    // Starting from a: a's children include b, b's children would include a
    // but a is already on the path → dropped.
    const tree = composeTree(flat, { on: 'father', rootId: 'a' })
    assert.equal(tree.xid, 'a')
    assert.equal(tree._children.length, 1)
    assert.equal(tree._children[0].xid, 'b')
    assert.equal(tree._children[0]._children.length, 0)
  })
})

describe('composeForest', () => {
  it('returns a single-tree forest when there is one root', () => {
    const forest = composeForest(family, { on: 'father' })
    assert.equal(forest.length, 1)
    assert.equal(forest[0].xid, 'howard')
  })

  it('returns multiple trees when multiple independent roots exist', () => {
    const flat = [
      { xid: 'r1', first_name: 'Root1', father: null },
      { xid: 'r2', first_name: 'Root2', father: null },
      { xid: 'c1', first_name: 'Child1', father: { xid: 'r1' } },
      { xid: 'c2', first_name: 'Child2', father: { xid: 'r2' } },
    ]
    const forest = composeForest(flat, { on: 'father' })
    assert.equal(forest.length, 2)
    assert.deepEqual(forest.map(t => t.xid).sort(), ['r1', 'r2'])
    assert.equal(forest.find(t => t.xid === 'r1')._children[0].xid, 'c1')
  })

  it('treats orphans (parent-id not in set) as roots', () => {
    const flat = [
      // father points outside the set — orphan, still a root
      { xid: 'o', father: { xid: 'missing-parent' } },
      { xid: 'k', father: { xid: 'o' } },
    ]
    const forest = composeForest(flat, { on: 'father' })
    assert.equal(forest.length, 1)
    assert.equal(forest[0].xid, 'o')
    assert.equal(forest[0]._children[0].xid, 'k')
  })

  it('returns [] for empty input', () => {
    assert.deepEqual(composeForest([], { on: 'father' }), [])
  })

  it('tolerates cycles without looping forever', () => {
    const flat = [
      { xid: 'a', father: { xid: 'b' } },
      { xid: 'b', father: { xid: 'a' } },
    ]
    // Both have a parent inside the set, so neither is a top-level root
    // by the "parent not in set" rule — forest is empty.
    const forest = composeForest(flat, { on: 'father' })
    assert.deepEqual(forest, [])
  })
})
