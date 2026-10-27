# SDEC-ERP backend

## Push notifications (My Task app)

The backend sends Firebase Cloud Messaging pushes next to its existing in-app
notifications and Socket.IO events. Code: `src/services/push.service.ts`
(the only module that talks to FCM). Tests: `npm run test:push`.

### Environment

| Variable | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Service-account JSON for Firebase project `my-task-85ec4` — raw JSON on one line, or base64 of it (`base64 -i key.json`). If unset, the server logs one warning and every push is a no-op. Never commit it. |
| `CRON_SECRET` | Shared secret for `POST /api/internal/due-reminders`, sent as the `X-Cron-Secret` header. If unset, the endpoint always returns 401. |

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/devices` | `{ "token": "<fcm token>", "platform": "android" \| "iOS" }` → 204. Upserts by token; a token registered by another user moves to the caller. Works for company and External accounts. |
| `DELETE` | `/api/devices/:token` | Removes the token only if it belongs to the caller → 204 either way. Call on logout. |
| `GET` | `/api/notification-preferences` | `{ push, taskUpdates, mentions, dueReminders }` (defaults `true, true, true, false`). |
| `PUT` | `/api/notification-preferences` | Any subset of the four booleans → full object. |
| `POST` | `/api/internal/due-reminders` | Cron only, `X-Cron-Secret` header. Returns `{ "sent": n }`. |

```sh
curl -X POST $API/api/devices -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
     -d '{"token":"<fcm token>","platform":"android"}'
```

### Due-date reminders (cron)

Every open My Task due within the next 60 minutes (Asia/Kolkata; no due time ⇒
09:00) gets one "Due soon" push, sent to its members and In-Charge (or its
creator if it has no members). `dueReminderSentAt` stops a second push; changing
the due date or time clears it.

The server also checks every 15 minutes while it is awake, but Render puts idle
instances to sleep, which stops that timer. To cover this, add a **Render Cron Job**
(or any external scheduler) that runs every 15 minutes:

- Schedule: `*/15 * * * *`
- Command:
  ```sh
  curl -fsS -X POST "$API/api/internal/due-reminders" -H "X-Cron-Secret: $CRON_SECRET"
  ```
- Set `API` (e.g. `https://sdec-erp-backend.onrender.com`) and `CRON_SECRET` on the cron job,
  and the same `CRON_SECRET` on the web service.

If the timer and the cron run at the same time, a task still gets only one reminder,
because each task is claimed before its push is sent.

### Database

Tables `device_tokens` and `notification_preferences`, plus the column
`my_tasks.due_reminder_sent_at`. They are created automatically on boot by
`src/config/initDb.ts`. To apply them to a running database without
redeploying: `psql "$DATABASE_URL" -f src/prisma/migrations/push_notifications.sql`.
