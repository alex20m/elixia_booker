'use client';

import { useState } from 'react';
import { apiRequest as api } from '@/lib/dashboardState';
import { MEMBERSHIP_OPTIONS } from '@/lib/membership';
import { TIME_ZONE_GROUPS } from '@/lib/timezones';
import type { DashboardView } from '@/lib/service';
import { ActionButton } from './components/ActionButton';
import { TelegramConnect } from './components/TelegramConnect';

/**
 * Booking settings and where alerts go — the two groups of answers the setup
 * pages collected, in one place so they can be changed later.
 *
 * Email is the default and needs nothing: the address arrives with the
 * account. Telegram is one tap — the Connect control asks the server for a deep
 * link and opens it, and the chat id comes back through the webhook, so nobody
 * has to read one out of a JSON document. That control is shared with the setup
 * wizard, which asks for the same thing in the same words.
 *
 * The manual chat-id field survives for deployments with no webhook
 * configured, which is the only state in which this form still writes a chat
 * id itself. Everywhere else it deliberately omits the field, because posting
 * a blank one would disconnect the chat on every save.
 */
export function SettingsPanel({
  view,
  refresh,
}: {
  view: DashboardView;
  refresh: () => Promise<void>;
}) {
  const [windowDays, setWindowDays] = useState(String(view.account.bookingWindowDays));
  const [timeZone, setTimeZone] = useState(view.account.timeZone);
  const [channel, setChannel] = useState(view.account.notifyChannel);
  const [email, setEmail] = useState(view.account.notifyEmail);
  const [chatId, setChatId] = useState(view.account.telegramChatId);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  /**
   * Change a field, and withdraw the "Saved" acknowledgement while doing it.
   *
   * The acknowledgement used to survive every later edit, so a user who saved
   * once and then picked a different channel was looking at a button that
   * claimed their unsaved choice was already stored. Nothing on the page said
   * otherwise, so the ordinary outcome was leaving the tab believing alerts had
   * moved when they had not.
   */
  const edit = <T,>(set: (value: T) => void, value: T): void => {
    setSaved(false);
    set(value);
  };

  const connected = Boolean(view.account.telegramChatId);
  // The one-tap flow needs a bot, a webhook and a secret. Without them the old
  // manual field is the only way Telegram can work at all.
  const canConnect = view.telegramConnect;

  const disconnect = async () => {
    await api('/api/telegram/link', { method: 'DELETE' });
    await refresh();
  };

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Booking</h2>
            <p className="card-sub">Both of these decide when a booking fires.</p>
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label htmlFor="tier">Membership</label>
            <select
              id="tier"
              value={windowDays}
              onChange={(e) => edit(setWindowDays, e.target.value)}
            >
              {MEMBERSHIP_OPTIONS.map((option) => (
                <option key={option.days} value={String(option.days)}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="tz">Timezone</label>
            {/* A picker here too, and for the same reason it is one during setup:
                this field used to be a text box, and "Europe/Helsinky" saved from
                it is a booking window that never opens. The server accepts only
                these ids. */}
            <select id="tz" value={timeZone} onChange={(e) => edit(setTimeZone, e.target.value)}>
              {TIME_ZONE_GROUPS.map((group) => (
                <optgroup key={group.region} label={group.region}>
                  {group.zones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Notifications</h2>
            <p className="card-sub">Where Booker tells you what it did.</p>
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label htmlFor="notify-channel">Send alerts by</label>
            <select
              id="notify-channel"
              value={channel}
              onChange={(e) =>
                edit(setChannel, e.target.value as DashboardView['account']['notifyChannel'])
              }
            >
              <option value="email">Email</option>
              <option value="telegram">Telegram</option>
              <option value="none">Off</option>
            </select>
          </div>
          {channel === 'email' && (
            <div className="field">
              <label htmlFor="notify-email">Email address</label>
              <input
                id="notify-email"
                type="email"
                value={email}
                onChange={(e) => edit(setEmail, e.target.value)}
              />
            </div>
          )}
        </div>

        {/* Disconnecting leaves the channel where the user put it rather than
            moving them to email on their behalf — so this is a state they can
            genuinely be sitting in, and it has to be said out loud. Silence here
            is a user who believes they are covered and hears nothing, including
            when booking stops. */}
        {channel === 'telegram' && !connected && (
          <div className="banner banner-warn mt-s" id="notify-broken">
            <span>
              Telegram is selected but no chat is connected, so alerts are{' '}
              <strong>not being delivered</strong>. Connect one below, or choose another channel.
            </span>
          </div>
        )}

        {channel === 'telegram' && canConnect && (
          <div className="mt-s">
            <TelegramConnect
              chatId={view.account.telegramChatId}
              check={refresh}
              onError={setError}
              onDisconnect={disconnect}
            />
          </div>
        )}

        {channel === 'telegram' && !canConnect && (
          <div className="field mt-s">
            <label htmlFor="tg">Telegram chat ID</label>
            <input
              id="tg"
              placeholder="e.g. 123456789"
              value={chatId}
              onChange={(e) => edit(setChatId, e.target.value)}
            />
            <p className="hint">
              This deployment has no Telegram webhook configured, so the chat ID has to be entered
              by hand.
            </p>
          </div>
        )}

        {channel === 'none' && (
          <p className="hint mt-s">
            Bookings still run — you just will not be told about them, including when your Elixia
            session expires and booking stops.
          </p>
        )}

        {error && (
          <div className="banner banner-err mt-s">
            <span>{error}</span>
          </div>
        )}

        {/* The wait, the refusal of a second press, and the withdrawal of
            "Saved" the moment a field is edited: a second PUT races the refresh
            the first one triggered, and an impatient press on a slow connection
            is the ordinary way to get there rather than an edge case. */}
        <ActionButton
          id="save-btn"
          className="btn-block mt-m"
          pendingLabel="Saving…"
          onError={(err) => setError(err.message)}
          onClick={async () => {
            setError('');
            setSaved(false);
            await api('/api/settings', {
              method: 'PUT',
              body: JSON.stringify({
                bookingWindowDays: Number(windowDays),
                timeZone,
                notifyChannel: channel,
                // Only where this form owns the value. Sending it when the
                // connect flow does would post a blank on every save and
                // disconnect the chat the user just linked.
                ...(canConnect ? {} : { telegramChatId: chatId }),
                notifyEmail: email,
              }),
            });
            setSaved(true);
            await refresh();
          }}
        >
          {saved ? 'Saved' : 'Save settings'}
        </ActionButton>
      </section>
    </>
  );
}
