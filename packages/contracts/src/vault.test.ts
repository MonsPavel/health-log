// TASK-094 §5/§11/§19: контракт каналов vault/* — статус/разблокировка/блокировка/
// управление паролем (локальный вход, эпик 6.1). Плюс ИНВЕНТАРЬ secure-флага (AC5):
// каждый БД-канал реестра помечен secure: true — гвардия requireUnlocked каркаса
// (единая обёртка, §7/§11) отклоняет вызовы в locked-состоянии кодом VAULT/LOCKED.
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ChannelName, ChannelRequest, ChannelResponse } from './channels.js';
import { CHANNEL_SCHEMAS } from './schemas.js';
import {
  VAULT_LOCKED_ERROR,
  VAULT_LOCKED_MESSAGE_KEY,
  VAULT_LOCK_REQUEST_SCHEMA,
  VAULT_LOCK_RESPONSE_SCHEMA,
  VAULT_SET_PASSPHRASE_REQUEST_SCHEMA,
  VAULT_SET_PASSPHRASE_RESPONSE_SCHEMA,
  VAULT_STATUS_REQUEST_SCHEMA,
  VAULT_STATUS_RESPONSE_SCHEMA,
  VAULT_UNLOCK_REQUEST_SCHEMA,
  VAULT_UNLOCK_RESPONSE_SCHEMA,
} from './vault.js';

describe('каналы vault/* — формы payload (TASK-094 §5/§11)', () => {
  it('vault/status: {} → {mode, locked, backoffSec?} — backoffSec только в окне backoff (§17)', () => {
    expect(VAULT_STATUS_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(VAULT_STATUS_REQUEST_SCHEMA.safeParse({ extra: 1 }).success).toBe(false);
    expect(VAULT_STATUS_RESPONSE_SCHEMA.safeParse({ mode: 'none', locked: false }).success).toBe(
      true,
    );
    expect(
      VAULT_STATUS_RESPONSE_SCHEMA.safeParse({
        mode: 'passphrase',
        locked: true,
        backoffSec: 4,
      }).success,
    ).toBe(true);
    expect(
      VAULT_STATUS_RESPONSE_SCHEMA.safeParse({ mode: 'passphrase', locked: true, backoffSec: 0 })
        .success,
    ).toBe(false);
    expectTypeOf<ChannelResponse<'vault/status'>>().toEqualTypeOf<{
      mode: 'none' | 'passphrase';
      locked: boolean;
      backoffSec?: number;
    }>();
  });

  it('vault/unlock: {pass} → {ok: true}; ошибка — конверт отказа каркаса (§5)', () => {
    expect(VAULT_UNLOCK_REQUEST_SCHEMA.safeParse({ pass: 'пароль' }).success).toBe(true);
    expect(VAULT_UNLOCK_REQUEST_SCHEMA.safeParse({ pass: '' }).success).toBe(false);
    expect(VAULT_UNLOCK_REQUEST_SCHEMA.safeParse({}).success).toBe(false);
    expect(VAULT_UNLOCK_RESPONSE_SCHEMA.safeParse({ ok: true }).success).toBe(true);
    expectTypeOf<ChannelRequest<'vault/unlock'>>().toEqualTypeOf<{ pass: string }>();
    expectTypeOf<ChannelResponse<'vault/unlock'>>().toEqualTypeOf<{ ok: true }>();
  });

  it('vault/lock: {} → {locked} — результирующее состояние (mode=none — no-op, locked:false)', () => {
    expect(VAULT_LOCK_REQUEST_SCHEMA.safeParse({}).success).toBe(true);
    expect(VAULT_LOCK_RESPONSE_SCHEMA.safeParse({ locked: true }).success).toBe(true);
    expect(VAULT_LOCK_RESPONSE_SCHEMA.safeParse({ locked: false }).success).toBe(true);
  });

  it('vault/set-passphrase: union по action — {set, pass} | {change, old, new} | {remove, old} (§5)', () => {
    expect(
      VAULT_SET_PASSPHRASE_REQUEST_SCHEMA.safeParse({ action: 'set', pass: 'пароль' }).success,
    ).toBe(true);
    expect(
      VAULT_SET_PASSPHRASE_REQUEST_SCHEMA.safeParse({
        action: 'change',
        old: 'старый',
        new: 'новый',
      }).success,
    ).toBe(true);
    expect(
      VAULT_SET_PASSPHRASE_REQUEST_SCHEMA.safeParse({ action: 'remove', old: 'старый' }).success,
    ).toBe(true);
    // Чужие action и неполные формы — отказ (strict, §14).
    expect(VAULT_SET_PASSPHRASE_REQUEST_SCHEMA.safeParse({ action: 'reset' }).success).toBe(false);
    expect(
      VAULT_SET_PASSPHRASE_REQUEST_SCHEMA.safeParse({ action: 'set', pass: 'п', extra: 1 }).success,
    ).toBe(false);
    expect(
      VAULT_SET_PASSPHRASE_REQUEST_SCHEMA.safeParse({ action: 'change', old: 'а' }).success,
    ).toBe(false);
    expect(VAULT_SET_PASSPHRASE_RESPONSE_SCHEMA.safeParse({ mode: 'passphrase' }).success).toBe(
      true,
    );
  });
});

describe('VAULT_LOCKED — ошибка гвардии каркаса (TASK-094 §7/§11)', () => {
  it('DTO с ключом каталога errors.VAULT_LOCKED (конвенция арх. 05 §29)', () => {
    expect(VAULT_LOCKED_ERROR).toEqual({ code: 'VAULT/LOCKED', messageKey: 'errors.VAULT_LOCKED' });
    expect(VAULT_LOCKED_MESSAGE_KEY).toBe('errors.VAULT_LOCKED');
  });
});

/**
 * Инвентарь каналов (AC5, §11): каждый ChannelName отнесён ровно к одной из двух
 * групп — БД-каналы (secure: true, гвардия requireUnlocked) и прочие (доступны при
 * locked). Новый канал, добавленный в union без решения о secure, роняет этот тест.
 */
const SECURE_CHANNELS: readonly ChannelName[] = [
  '__bench/seed',
  'ai/cancel',
  'ai/chat/clear',
  'ai/chat/list',
  'ai/chat/send',
  'ai/context/preview',
  'ai/models/download',
  'ai/models/list',
  'ai/models/pause',
  'ai/models/reset',
  'ai/models/resume',
  'ai/models/select',
  'ai/summary/delete-all',
  'ai/summary/generate',
  'ai/summary/latest',
  'backup/create',
  'backup/restore',
  // TASK-101 §5/§9/§14: «начать заново» recovery-экрана — файловая операция данных
  // (unlink db/-wal/-shm); регистрируется только в recovery-режиме и в его наборе
  // разрешённых secure-каналов (инвентарь-тест контейнера TASK-101).
  'data/discard-db',
  'data/wipe',
  'measurements/add',
  'measurements/delete',
  'measurements/list',
  'measurements/update',
  'notes/search',
  'prefs/get',
  'prefs/set',
  // TASK-098 §8/§14: журнал сети (network_event) и согласия (prefs) — чтение/запись
  // БД; при locked недоступны (гвардия каркаса, прецедент prefs/*).
  'privacy/journal',
  'privacy/consents',
  'report/export-csv',
  'report/export-json',
  'report/pdf',
  'scales/active',
  'stats/period',
  'trend/series',
  'updates/check',
  'updates/download',
  'updates/install',
  // Ревью TASK-094: смена/снятие пароля — те же vault-операции, что и unlock, и
  // ОБЯЗАНЫ гвардиться в locked — иначе канал даёт неthrottled-оракул того же
  // секрета (change/remove у порта 093 делают полную проверку пароля Argon2id+GCM
  // без всякого backoff) и молча перепаковывает vault.key на угаданный пароль.
  'vault/set-passphrase',
  // TASK-100 §4/§11: полная проверка БД (PRAGMA integrity_check) — БД-канал:
  // при locked соединение закрыто, гвардия даёт честный VAULT/LOCKED.
  'app/integrity-full',
];

/**
 * Не-БД каналы: каркасные, диалоговые и МИНИМАЛЬНЫЙ входной набор vault/*
 * (статус/unlock/lock — доступ к ним и есть выход из lock; §5 «повторный unlock
 * открывает»). Управление паролем в набор не входит — только из открытой сессии.
 */
const OPEN_CHANNELS: readonly ChannelName[] = [
  // TASK-095 §11: heartbeat активности — безопасный сигнал автоблока, продлевает
  // сессию и в locked (блокировать активность бессмысленно — сессия уже закрыта).
  'app/heartbeat',
  'app/log-client-error',
  'app/ping',
  'app/reveal-path',
  // TASK-100 §11: сампроверка (отчёт — снимок памяти main, БД не читает) и версии
  // «О приложении» — без PHI (§14); в recovery-режиме TASK-101 §9 app/meta остаётся
  // в наборе доступных каналов (определение режима приложения до роутера).
  'app/selfcheck',
  'app/meta',
  // TASK-101 §5/§9/§14: «Открыть папку с копиями» recovery-экрана — путь каталога
  // копий строит main, запрос параметров не несёт (прецедент app/reveal-path).
  'app/reveal-backups',
  'file/open-dialog',
  'vault/lock',
  'vault/status',
  'vault/unlock',
];

describe('secure-флаг реестра — инвентарь каналов (TASK-094 §11, AC5)', () => {
  /** Читает secure-флаг записи реестра (опционален — union без него на части записей). */
  const secureOf = (name: ChannelName): boolean | undefined =>
    (CHANNEL_SCHEMAS[name] as { secure?: boolean }).secure;

  it('каждый БД-канал помечен secure: true — гвардия requireUnlocked (§7/§11)', () => {
    for (const name of SECURE_CHANNELS) {
      expect(secureOf(name), `канал ${name} должен быть secure`).toBe(true);
    }
  });

  it('vault/* и каркасные каналы НЕ secure — доступны в locked (иначе вход невозможен)', () => {
    for (const name of OPEN_CHANNELS) {
      expect(secureOf(name), `канал ${name} не должен быть secure`).not.toBe(true);
    }
  });

  it('инвентарь покрывает ВСЕ каналы union — новый канал без решения о secure роняет тест', () => {
    const known = [...SECURE_CHANNELS, ...OPEN_CHANNELS].sort();
    expect(known).toEqual(Object.keys(CHANNEL_SCHEMAS).sort());
  });
});

describe('каналы vault/* в union ChannelName (TASK-094 §5)', () => {
  it('все четыре канала присутствуют в реестре схем', () => {
    const names: readonly string[] = Object.keys(CHANNEL_SCHEMAS);
    expect(names).toContain('vault/status');
    expect(names).toContain('vault/unlock');
    expect(names).toContain('vault/lock');
    expect(names).toContain('vault/set-passphrase');
  });
});
