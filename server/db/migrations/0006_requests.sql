CREATE TABLE owner_credentials(token_hash TEXT PRIMARY KEY,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE request_sessions(id TEXT PRIMARY KEY,token TEXT UNIQUE NOT NULL,expires_at INTEGER NOT NULL,closed INTEGER NOT NULL DEFAULT 0,subset_json TEXT NOT NULL);
CREATE TABLE guest_requests(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES request_sessions(id),visitor TEXT NOT NULL,kind TEXT NOT NULL,item_id TEXT NOT NULL,nickname TEXT NOT NULL,note TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','ACCEPTED','REJECTED')),created_at INTEGER NOT NULL);
CREATE INDEX guest_request_rate ON guest_requests(session_id,visitor,created_at);
