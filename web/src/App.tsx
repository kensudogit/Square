import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  setToken,
  getToken,
  type Course,
  type Entitlement,
  type PublicConfig,
} from "./api.js";
import { PaymentForm } from "./payments/PaymentForm.js";

type User = { id: string; email: string; displayName: string };
type View = { name: "list" } | { name: "pay"; course: Course } | { name: "done"; course: Course };

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [view, setView] = useState<View>({ name: "list" });
  const [bootError, setBootError] = useState<string | null>(null);

  // 公開設定（application ID / location ID）はサーバーから取る。
  // access token は含まれないので、フロントに渡ってよい値だけが来る
  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => setBootError("サーバーに接続できません。バックエンドが起動しているか確認してください。"));
  }, []);

  useEffect(() => {
    if (!getToken()) return;
    api.me().then(setUser).catch(() => setToken(null));
  }, []);

  const refresh = useCallback(async () => {
    setCourses(await api.listCourses());
    if (getToken()) {
      try {
        setEntitlements(await api.listEntitlements());
      } catch {
        setEntitlements([]);
      }
    } else {
      setEntitlements([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, user]);

  if (bootError) return <main className="app"><p className="error">{bootError}</p></main>;
  if (!config) return <main className="app"><p className="muted">読み込み中…</p></main>;

  return (
    <main className="app">
      <header>
        <h1>受講申込</h1>
        <div className="header-right">
          {config.squareEnvironment === "sandbox" && (
            <span className="badge">SANDBOX — 実際の請求は発生しません</span>
          )}
          {user && (
            <span className="user">
              {user.displayName}
              <button
                className="link"
                onClick={() => {
                  setToken(null);
                  setUser(null);
                  setView({ name: "list" });
                }}
              >
                ログアウト
              </button>
            </span>
          )}
        </div>
      </header>

      {!user ? (
        <LoginForm onLoggedIn={setUser} />
      ) : view.name === "pay" ? (
        <PaymentForm
          config={config}
          courseId={view.course.id}
          buyer={splitName(user)}
          onSuccess={async () => {
            await refresh();
            setView({ name: "done", course: view.course });
          }}
          onCancel={() => setView({ name: "list" })}
        />
      ) : view.name === "done" ? (
        <section className="done">
          <h2>お申し込みが完了しました</h2>
          <p>
            「{view.course.title}」の受講権限を付与しました。下の「受講中のコース」に表示されています。
          </p>
          <button onClick={() => setView({ name: "list" })}>コース一覧へ戻る</button>
        </section>
      ) : (
        <CourseList
          courses={courses}
          entitlements={entitlements}
          paymentsEnabled={config.paymentsEnabled}
          onBuy={(course) => setView({ name: "pay", course })}
        />
      )}

      {user && entitlements.length > 0 && (
        <section className="entitlements">
          <h2>受講中のコース</h2>
          <ul>
            {entitlements.map((e) => (
              <li key={e.courseId}>
                <strong>{e.title}</strong>
                <span className="muted"> — {new Date(e.grantedAt).toLocaleString("ja-JP")} 付与</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------- login

function LoginForm({ onLoggedIn }: { onLoggedIn: (user: User) => void }) {
  // パスワードはフロントのソースに置かない。db:seed の出力に表示されたものを入力する
  const [email, setEmail] = useState("taro@example.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email, password);
      setToken(result.token);
      onLoggedIn(result.user);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "invalid_credentials"
          ? "メールアドレスまたはパスワードが正しくありません。"
          : "ログインできませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h2>ログイン</h2>
      <label>
        メールアドレス
        <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
      </label>
      <label>
        パスワード
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "..." : "ログイン"}
      </button>
      <p className="note">npm run db:seed の出力に表示されたデモユーザーとパスワードでログインできます。</p>
    </form>
  );
}

// ---------------------------------------------------------------- courses

function CourseList({
  courses,
  entitlements,
  paymentsEnabled,
  onBuy,
}: {
  courses: Course[];
  entitlements: Entitlement[];
  paymentsEnabled: boolean;
  onBuy: (course: Course) => void;
}) {
  const owned = new Set(entitlements.map((e) => e.courseId));

  return (
    <section className="courses">
      <h2>コース一覧</h2>
      {!paymentsEnabled && (
        <p className="error">現在お支払いを停止しています（PAYMENTS_ENABLED=false）。</p>
      )}
      <ul>
        {courses.map((course) => (
          <li key={course.id}>
            <div>
              <strong>{course.title}</strong>
              <p className="muted">{course.description}</p>
            </div>
            <div className="price">
              <span>{course.amountLabel}</span>
              {owned.has(course.id) ? (
                <span className="owned">受講中</span>
              ) : (
                <button onClick={() => onBuy(course)} disabled={!paymentsEnabled}>
                  申し込む
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** billingContact 用に姓名を分ける。実運用では姓名を別々に持つべき */
function splitName(user: User): { givenName: string; familyName: string; email: string } {
  const [familyName = "", givenName = ""] = user.displayName.split(/\s+/);
  return { givenName, familyName, email: user.email };
}
