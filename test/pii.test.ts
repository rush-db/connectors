import { describe, expect, it } from 'vitest'

import { applyFieldPolicy, detectPii, hashPiiValue, policyFromReview, profileFields } from '../src/pii'

describe('detectPii', () => {
  it('flags fields by name', () => {
    expect(detectPii('email')?.kind).toBe('email')
    expect(detectPii('workEmail')?.kind).toBe('email')
    expect(detectPii('mobile_phone')?.kind).toBe('phone')
    expect(detectPii('date_of_birth')?.kind).toBe('birthdate')
    expect(detectPii('SSN')?.kind).toBe('national_id')
    expect(detectPii('billing_address_line1')?.kind).toBe('address')
    expect(detectPii('api_key')?.kind).toBe('credentials')
    expect(detectPii('amount')).toBeUndefined()
    expect(detectPii('status')).toBeUndefined()
  })

  it('flags fields by sampled values', () => {
    expect(detectPii('contact', ['a@b.co', 'c@d.org'])?.kind).toBe('email')
    expect(detectPii('x', ['4111 1111 1111 1111'])?.kind).toBe('payment_card')
    expect(detectPii('x', ['4111 1111 1111 1112'])).toBeUndefined()
    expect(detectPii('x', ['DE89370400440532013000'])?.kind).toBe('bank_account')
    expect(detectPii('x', ['10.0.0.1', '192.168.1.2'])?.kind).toBe('ip_address')
    expect(detectPii('x', ['+1 (415) 555-0100'])?.kind).toBe('phone')
    expect(detectPii('order_total', ['1999', '25'])).toBeUndefined()
  })
})

describe('applyFieldPolicy', () => {
  const record = { email: 'Ada@Example.com', name: 'Ada', amount: 10, phone: '+1 555 0100', external_id: '7', notes: 'x' }

  it('auto mode drops name-detected personal data and keeps the rest', () => {
    const { properties, dropped } = applyFieldPolicy(record, null)
    expect(properties).toEqual({ name: 'Ada', amount: 10, external_id: '7', notes: 'x' })
    expect(dropped.sort()).toEqual(['email', 'phone'])
  })

  it('allowlist mode passes only reviewed fields and reports new ones', () => {
    const policy = policyFromReview([
      { name: 'amount', action: 'include' },
      { name: 'email', action: 'hash' },
      { name: 'phone', action: 'exclude' }
    ])
    const { properties, unreviewed } = applyFieldPolicy(record, policy, 'k')
    expect(properties).toEqual({ amount: 10, email: hashPiiValue('ada@example.com', 'k'), external_id: '7' })
    expect(unreviewed.sort()).toEqual(['name', 'notes'])
  })

  it('hashes consistently (case-insensitive) and drops hash fields without a key', () => {
    expect(hashPiiValue('A@B.c', 'k')).toBe(hashPiiValue('a@b.c ', 'k'))
    expect(hashPiiValue('a@b.c', 'k')).not.toBe(hashPiiValue('a@b.c', 'other'))
    expect(applyFieldPolicy({ email: 'a@b.c' }, { mode: 'auto', hash: ['email'] }).properties).toEqual({})
  })
})

describe('profileFields', () => {
  it('profiles types and suggests hashing joinable identifiers and excluding the rest', () => {
    const profiles = profileFields([
      { email: 'a@b.co', dob: '1990-01-02', plan: 'pro', seats: 3, external_id: '1' },
      { email: 'c@d.co', dob: '1985-05-06', plan: 'free', seats: 1, external_id: '2' }
    ])
    const by = Object.fromEntries(profiles.map((profile) => [profile.name, profile]))
    expect(by.external_id).toBeUndefined()
    expect(by.email).toMatchObject({ suggestion: 'hash', pii: { kind: 'email' } })
    expect(by.email.example).not.toContain('a@b.co')
    expect(by.dob).toMatchObject({ suggestion: 'exclude', type: 'datetime' })
    expect(by.plan).toMatchObject({ suggestion: 'include', example: 'pro' })
    expect(by.seats.type).toBe('number')
  })
})
