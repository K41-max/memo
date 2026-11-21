const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL接続設定（Render / Neon / Supabase対応）
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
let pool = null;

if (hasDatabaseUrl) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false }
  });
}

// ローカルテスト用の簡易JSON保存（DATABASE_URLがない場合のみ使用）
const LOCAL_DB_FILE = path.join(__dirname, 'local-data.json');
function readLocalData() {
  if (!fs.existsSync(LOCAL_DB_FILE)) {
    return {
      notes: [
        {
          id: '1',
          title: 'welcome.md',
          content: '// GitHub風のマルチメモ＆カレンダーへようこそ！\n// データはサーバーのデータベースに保存されます。',
          updatedAt: new Date().toISOString()
        }
      ],
      events: []
    };
  }
  return JSON.parse(fs.readFileSync(LOCAL_DB_FILE, 'utf8'));
}
function writeLocalData(data) {
  fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(data, null, 2));
}

// DBテーブル初期化
async function initDB() {
  if (!pool) {
    console.log('⚠️ DATABASE_URLが未設定のため、ローカルJSONモードで起動します（Render本番ではDATABASE_URLを設定してください）');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      event_date TEXT NOT NULL,
      event_time TEXT DEFAULT '',
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 初回ノートが0件ならウェルカムノートを作成
  const { rows } = await pool.query('SELECT COUNT(*) FROM notes');
  if (parseInt(rows[0].count, 10) === 0) {
    await pool.query(
      'INSERT INTO notes (id, title, content, updated_at) VALUES ($1, $2, $3, $4)',
      [
        '1',
        'welcome.md',
        '// GitHub風のマルチメモ＆カレンダーへようこそ！\n// データベース接続済みのため、長時間アクセスしなくてもデータは消えません。',
        new Date().toISOString()
      ]
    );
  }
  console.log('✅ PostgreSQL データベース初期化完了');
}

// ========================
// ノート API
// ========================

// 一覧取得
app.get('/api/notes', async (req, res) => {
  try {
    if (!pool) {
      return res.json(readLocalData().notes);
    }
    const { rows } = await pool.query(
      'SELECT id, title, content, updated_at AS "updatedAt" FROM notes ORDER BY id ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ノートの取得に失敗しました' });
  }
});

// 新規作成
app.post('/api/notes', async (req, res) => {
  try {
    const { id, title, content } = req.body;
    const now = new Date().toISOString();

    if (!pool) {
      const data = readLocalData();
      const newNote = { id, title, content: content || '', updatedAt: now };
      data.notes.push(newNote);
      writeLocalData(data);
      return res.json(newNote);
    }

    const { rows } = await pool.query(
      'INSERT INTO notes (id, title, content, updated_at) VALUES ($1, $2, $3, $4) RETURNING id, title, content, updated_at AS "updatedAt"',
      [id, title, content || '', now]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ノートの作成に失敗しました' });
  }
});

// 更新（名前変更・内容保存）
app.put('/api/notes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content } = req.body;
    const now = new Date().toISOString();

    if (!pool) {
      const data = readLocalData();
      const note = data.notes.find(n => n.id === id);
      if (!note) return res.status(404).json({ error: 'Not found' });
      if (title !== undefined) note.title = title;
      if (content !== undefined) note.content = content;
      note.updatedAt = now;
      writeLocalData(data);
      return res.json(note);
    }

    const { rows } = await pool.query(
      `UPDATE notes
       SET title = COALESCE($1, title),
           content = COALESCE($2, content),
           updated_at = $3
       WHERE id = $4
       RETURNING id, title, content, updated_at AS "updatedAt"`,
      [title ?? null, content ?? null, now, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ノートの更新に失敗しました' });
  }
});

// 削除
app.delete('/api/notes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!pool) {
      const data = readLocalData();
      data.notes = data.notes.filter(n => n.id !== id);
      writeLocalData(data);
      return res.json({ success: true });
    }

    await pool.query('DELETE FROM notes WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ノートの削除に失敗しました' });
  }
});

// ========================
// カレンダー予定 API
// ========================

// 予定一覧取得
app.get('/api/events', async (req, res) => {
  try {
    if (!pool) {
      return res.json(readLocalData().events);
    }
    const { rows } = await pool.query(
      'SELECT id, event_date AS "date", event_time AS "time", title, description, updated_at AS "updatedAt" FROM calendar_events ORDER BY event_date ASC, event_time ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '予定の取得に失敗しました' });
  }
});

// 予定追加
app.post('/api/events', async (req, res) => {
  try {
    const { id, date, time, title, description } = req.body;
    const now = new Date().toISOString();

    if (!pool) {
      const data = readLocalData();
      const newEvent = { id, date, time: time || '', title, description: description || '', updatedAt: now };
      data.events.push(newEvent);
      writeLocalData(data);
      return res.json(newEvent);
    }

    const { rows } = await pool.query(
      `INSERT INTO calendar_events (id, event_date, event_time, title, description, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, event_date AS "date", event_time AS "time", title, description, updated_at AS "updatedAt"`,
      [id, date, time || '', title, description || '', now]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '予定の追加に失敗しました' });
  }
});

// 予定削除
app.delete('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!pool) {
      const data = readLocalData();
      data.events = data.events.filter(e => e.id !== id);
      writeLocalData(data);
      return res.json({ success: true });
    }

    await pool.query('DELETE FROM calendar_events WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '予定の削除に失敗しました' });
  }
});

// サーバー起動
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('DB初期化エラー:', err);
    process.exit(1);
  });
