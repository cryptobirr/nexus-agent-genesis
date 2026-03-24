import { describe, it, expect } from 'vitest'
import { DomainRegistry } from './domain-registry.js'
import type { DomainHint } from './types.js'

describe('DomainRegistry', () => {
  describe('register() + get()', () => {
    it('should store and retrieve registered domains', () => {
      const registry = new DomainRegistry()
      const domain: DomainHint = {
        domain_id: 'auth',
        keywords: ['authentication', 'login', 'oauth']
      }

      registry.register(domain)
      const result = registry.get('auth')

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual(domain)
    })

    it('should return empty array for unknown domain_id', () => {
      const registry = new DomainRegistry()
      const result = registry.get('nonexistent')

      expect(result).toEqual([])
    })

    it('should support idempotent re-registration (overwrite)', () => {
      const registry = new DomainRegistry()

      registry.register({ domain_id: 'foo', keywords: ['a', 'b'] })
      registry.register({ domain_id: 'foo', keywords: ['c', 'd'] })

      const result = registry.get('foo')
      expect(result).toHaveLength(1)
      expect(result[0].keywords).toEqual(['c', 'd'])
    })

    it('should return deep copy to prevent mutation', () => {
      const registry = new DomainRegistry()
      const domain: DomainHint = {
        domain_id: 'test',
        keywords: ['original']
      }

      registry.register(domain)
      const result = registry.get('test')
      result[0].keywords.push('mutated')

      const result2 = registry.get('test')
      expect(result2[0].keywords).toEqual(['original'])
    })
  })

  describe('match()', () => {
    it('should find domains by keyword match', () => {
      const registry = new DomainRegistry()

      registry.register({
        domain_id: 'auth',
        keywords: ['authentication', 'login']
      })
      registry.register({
        domain_id: 'db',
        keywords: ['database', 'postgres']
      })

      const authMatches = registry.match('user authentication flow')
      expect(authMatches).toHaveLength(1)
      expect(authMatches[0].domain_id).toBe('auth')

      const dbMatches = registry.match('database query optimization')
      expect(dbMatches).toHaveLength(1)
      expect(dbMatches[0].domain_id).toBe('db')
    })

    it('should return multiple domains when multiple keywords match', () => {
      const registry = new DomainRegistry()

      registry.register({
        domain_id: 'auth',
        keywords: ['authentication']
      })
      registry.register({
        domain_id: 'db',
        keywords: ['database']
      })

      const matches = registry.match('authentication and database setup')
      expect(matches).toHaveLength(2)
      expect(matches.map(d => d.domain_id).sort()).toEqual(['auth', 'db'])
    })

    it('should perform case-insensitive matching', () => {
      const registry = new DomainRegistry()

      registry.register({
        domain_id: 'auth',
        keywords: ['Authentication']
      })

      const matches = registry.match('AUTHENTICATION flow')
      expect(matches).toHaveLength(1)
      expect(matches[0].domain_id).toBe('auth')
    })

    it('should return empty array when no keywords match', () => {
      const registry = new DomainRegistry()

      registry.register({
        domain_id: 'auth',
        keywords: ['authentication']
      })

      const matches = registry.match('completely unrelated text')
      expect(matches).toEqual([])
    })

    it('should return deep copies to prevent mutation', () => {
      const registry = new DomainRegistry()

      registry.register({
        domain_id: 'test',
        keywords: ['keyword']
      })

      const matches = registry.match('keyword search')
      matches[0].keywords.push('mutated')

      const matches2 = registry.match('keyword search')
      expect(matches2[0].keywords).toEqual(['keyword'])
    })
  })
})
