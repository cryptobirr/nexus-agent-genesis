import { describe, it, expect, beforeEach } from 'vitest'
import { BlobStore } from './blob-store.js'
import { BlobNotFoundError } from './types.js'

describe('BlobStore', () => {
  let store: BlobStore

  beforeEach(() => {
    store = new BlobStore()
  })

  describe('write() - returns valid DataRef', () => {
    it('returns DataRef with ref_id, schema, size_bytes', () => {
      const payload = { foo: 'bar', count: 42 }
      const ref = store.write('run-1', payload, 'TestSchema')

      expect(ref).toHaveProperty('ref_id')
      expect(ref.ref_id).toBeTypeOf('string')
      expect(ref.ref_id.length).toBeGreaterThan(0)
      expect(ref.schema).toBe('TestSchema')
      expect(ref.size_bytes).toBeTypeOf('number')
      expect(ref.size_bytes).toBeGreaterThan(0)
    })

    it('generates unique ref_id for each write', () => {
      const payload = { data: 'test' }
      const ref1 = store.write('run-1', payload, 'Schema')
      const ref2 = store.write('run-1', payload, 'Schema')

      expect(ref1.ref_id).not.toBe(ref2.ref_id)
    })

    it('correctly calculates size_bytes', () => {
      const payload = { foo: 'bar' }
      const expectedSize = JSON.stringify(payload).length
      const ref = store.write('run-1', payload, 'Schema')

      expect(ref.size_bytes).toBe(expectedSize)
    })

    it('stores payload correctly (verified by read)', () => {
      const payload = { nested: { data: [1, 2, 3] } }
      const ref = store.write('run-1', payload, 'Schema')
      const retrieved = store.read(ref.ref_id)

      expect(retrieved).toEqual(payload)
    })

    it('handles different payload types', () => {
      const stringPayload = 'test string'
      const numberPayload = 12345
      const arrayPayload = [1, 2, 3]
      const objectPayload = { key: 'value' }

      const ref1 = store.write('run-1', stringPayload, 'String')
      const ref2 = store.write('run-1', numberPayload, 'Number')
      const ref3 = store.write('run-1', arrayPayload, 'Array')
      const ref4 = store.write('run-1', objectPayload, 'Object')

      expect(store.read(ref1.ref_id)).toBe(stringPayload)
      expect(store.read(ref2.ref_id)).toBe(numberPayload)
      expect(store.read(ref3.ref_id)).toEqual(arrayPayload)
      expect(store.read(ref4.ref_id)).toEqual(objectPayload)
    })
  })

  describe('read() - returns exact payload', () => {
    it('returns exact payload written', () => {
      const payload = { message: 'hello', value: 123 }
      const ref = store.write('run-1', payload, 'Schema')
      const retrieved = store.read(ref.ref_id)

      expect(retrieved).toEqual(payload)
    })

    it('throws BlobNotFoundError on missing ref_id', () => {
      expect(() => {
        store.read('non-existent-ref')
      }).toThrow(BlobNotFoundError)
    })

    it('BlobNotFoundError contains ref_id in message', () => {
      try {
        store.read('missing-blob-123')
        expect.fail('Should have thrown BlobNotFoundError')
      } catch (error) {
        expect(error).toBeInstanceOf(BlobNotFoundError)
        expect((error as BlobNotFoundError).ref_id).toBe('missing-blob-123')
        expect((error as BlobNotFoundError).message).toContain('missing-blob-123')
      }
    })

    it('returns correct payload after multiple writes', () => {
      const payload1 = { id: 1 }
      const payload2 = { id: 2 }
      const payload3 = { id: 3 }

      const ref1 = store.write('run-1', payload1, 'Schema')
      const ref2 = store.write('run-1', payload2, 'Schema')
      const ref3 = store.write('run-1', payload3, 'Schema')

      expect(store.read(ref2.ref_id)).toEqual(payload2)
      expect(store.read(ref1.ref_id)).toEqual(payload1)
      expect(store.read(ref3.ref_id)).toEqual(payload3)
    })
  })

  describe('delete() - removes blob', () => {
    it('removes blob from storage', () => {
      const payload = { data: 'test' }
      const ref = store.write('run-1', payload, 'Schema')

      store.delete(ref.ref_id)

      expect(() => {
        store.read(ref.ref_id)
      }).toThrow(BlobNotFoundError)
    })

    it('delete is idempotent (no error on double delete)', () => {
      const payload = { data: 'test' }
      const ref = store.write('run-1', payload, 'Schema')

      store.delete(ref.ref_id)
      store.delete(ref.ref_id) // Should not throw

      expect(() => {
        store.read(ref.ref_id)
      }).toThrow(BlobNotFoundError)
    })

    it('deleting one blob does not affect others', () => {
      const ref1 = store.write('run-1', { id: 1 }, 'Schema')
      const ref2 = store.write('run-1', { id: 2 }, 'Schema')

      store.delete(ref1.ref_id)

      expect(() => store.read(ref1.ref_id)).toThrow(BlobNotFoundError)
      expect(store.read(ref2.ref_id)).toEqual({ id: 2 })
    })
  })

  describe('list() - scoped to run_id', () => {
    it('returns all DataRefs for run_id', () => {
      const ref1 = store.write('run-1', { id: 1 }, 'Schema1')
      const ref2 = store.write('run-1', { id: 2 }, 'Schema2')
      const ref3 = store.write('run-1', { id: 3 }, 'Schema1')

      const list = store.list('run-1')

      expect(list).toHaveLength(3)
      expect(list.map(r => r.ref_id)).toContain(ref1.ref_id)
      expect(list.map(r => r.ref_id)).toContain(ref2.ref_id)
      expect(list.map(r => r.ref_id)).toContain(ref3.ref_id)
    })

    it('returns empty array for run with no blobs', () => {
      store.write('run-1', { data: 'test' }, 'Schema')
      const list = store.list('run-2')

      expect(list).toEqual([])
    })

    it('scoped to specific run_id (no cross-contamination)', () => {
      const ref1 = store.write('run-1', { id: 1 }, 'Schema')
      const ref2 = store.write('run-2', { id: 2 }, 'Schema')
      const ref3 = store.write('run-1', { id: 3 }, 'Schema')

      const list1 = store.list('run-1')
      const list2 = store.list('run-2')

      expect(list1).toHaveLength(2)
      expect(list1.map(r => r.ref_id)).toContain(ref1.ref_id)
      expect(list1.map(r => r.ref_id)).toContain(ref3.ref_id)
      expect(list1.map(r => r.ref_id)).not.toContain(ref2.ref_id)

      expect(list2).toHaveLength(1)
      expect(list2.map(r => r.ref_id)).toContain(ref2.ref_id)
    })

    it('list includes all DataRef fields', () => {
      const ref = store.write('run-1', { data: 'test' }, 'TestSchema')
      const list = store.list('run-1')

      expect(list).toHaveLength(1)
      expect(list[0]).toEqual(ref)
      expect(list[0]).toHaveProperty('ref_id')
      expect(list[0]).toHaveProperty('schema')
      expect(list[0]).toHaveProperty('size_bytes')
    })

    it('list updates after delete', () => {
      const ref1 = store.write('run-1', { id: 1 }, 'Schema')
      const ref2 = store.write('run-1', { id: 2 }, 'Schema')

      let list = store.list('run-1')
      expect(list).toHaveLength(2)

      store.delete(ref1.ref_id)

      list = store.list('run-1')
      expect(list).toHaveLength(1)
      expect(list[0].ref_id).toBe(ref2.ref_id)
    })
  })

  describe('Run isolation', () => {
    it('blobs from different runs are isolated', () => {
      const payload1 = { run: 1, data: 'first' }
      const payload2 = { run: 2, data: 'second' }

      const ref1 = store.write('run-1', payload1, 'Schema')
      const ref2 = store.write('run-2', payload2, 'Schema')

      expect(store.read(ref1.ref_id)).toEqual(payload1)
      expect(store.read(ref2.ref_id)).toEqual(payload2)

      expect(store.list('run-1')).toHaveLength(1)
      expect(store.list('run-2')).toHaveLength(1)
    })

    it('delete in one run does not affect other runs', () => {
      const ref1 = store.write('run-1', { data: 'test1' }, 'Schema')
      const ref2 = store.write('run-2', { data: 'test2' }, 'Schema')

      store.delete(ref1.ref_id)

      expect(() => store.read(ref1.ref_id)).toThrow(BlobNotFoundError)
      expect(store.read(ref2.ref_id)).toEqual({ data: 'test2' })
      expect(store.list('run-1')).toHaveLength(0)
      expect(store.list('run-2')).toHaveLength(1)
    })

    it('handles multiple runs with many blobs', () => {
      // Create blobs for 3 different runs
      for (let runNum = 1; runNum <= 3; runNum++) {
        for (let i = 0; i < 5; i++) {
          store.write(`run-${runNum}`, { run: runNum, id: i }, 'Schema')
        }
      }

      expect(store.list('run-1')).toHaveLength(5)
      expect(store.list('run-2')).toHaveLength(5)
      expect(store.list('run-3')).toHaveLength(5)
    })
  })
})
