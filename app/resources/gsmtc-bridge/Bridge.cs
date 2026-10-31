// GSMTC narrow bridge (工单336 production; recipe proven by t329 probe).
// .NET Framework 4.x console exe talking JSON-lines over stdio.
// Protocol (stdout, one JSON per line, "ts" = monotonic ms):
//   {"type":"ready"|"fatal", ...}
//   {"type":"result","id":N,"ok":true|false,"data":...,"error":"..."}
//   {"type":"event","event":"sessions-changed"|"current-session-changed"|"session-added"|"session-removed"|"session-updated",
//    "key":..., "what":"media|playback|timeline", "sessions":[keys]}
// Commands (stdin, one JSON per line):
//   {"id":1,"cmd":"list"}            -> light snapshots of all sessions + currentKey
//   {"id":2,"cmd":"snap","key":...}  -> full snapshot incl timeline + media (thumb meta only)
//   {"id":3,"cmd":"thumb","key":...} -> thumbnail bytes (base64) + format/size/timing
//   {"id":4,"cmd":"control","key":...,"action":"play|pause|toggle|next|previous"}
//                                    -> capability check + try + real status-change result
//   {"id":5,"cmd":"watch","on":true|false}
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

static class Bridge
{
    static GlobalSystemMediaTransportControlsSessionManager mgr;
    static readonly object gate = new object();
    static readonly Dictionary<string, GlobalSystemMediaTransportControlsSession> byKey =
        new Dictionary<string, GlobalSystemMediaTransportControlsSession>();
    static readonly Dictionary<GlobalSystemMediaTransportControlsSession, string> keyOf =
        new Dictionary<GlobalSystemMediaTransportControlsSession, string>();
    static readonly Dictionary<string, EventToken> sessionTokens =
        new Dictionary<string, EventToken>();
    static readonly Dictionary<string, int> genPerAumid = new Dictionary<string, int>();
    static readonly ConcurrentQueue<string> outq = new ConcurrentQueue<string>();
    static readonly Dictionary<string, GlobalSystemMediaTransportControlsSessionMediaProperties> mediaCache =
        new Dictionary<string, GlobalSystemMediaTransportControlsSessionMediaProperties>();
    static readonly AutoResetEvent outSignal = new AutoResetEvent(false);
    static bool watching = false;
    static readonly List<TypedEventHandler<GlobalSystemMediaTransportControlsSessionManager, object>> mgrHandlers =
        new List<TypedEventHandler<GlobalSystemMediaTransportControlsSessionManager, object>>();

    struct EventToken
    {
        // tokens dropped on the floor: winmd-projected EventRegistrationToken cannot be
        // named by this compiler (collides with mscorlib's); see SetWatch note.
    }

    static void Emit(string line)
    {
        outq.Enqueue(line);
        outSignal.Set();
    }

    static string Esc(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder();
        sb.Append('"');
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }

    static string JTs() { return ((long)StopwatchSingleton.Elapsed.TotalMilliseconds).ToString(); }

    // WinRT IAsyncOperation -> Task<T> via status polling (avoids AsTask/await glue,
    // which the inbox csc + GAC glue dll combination does not resolve cleanly).
    static Task<T> AwaitOp<T>(Windows.Foundation.IAsyncOperation<T> op)
    {
        return AwaitOp(op, 3000);
    }

    // 工单336 韧性：行为异常的源（如 MediaPlayer 型 SMTC 源）会让属性查询永不完成——
    // 无时限 AwaitOp 把整桥挂死（真机排障实证）。超时抛错由调用方缓存兜底。
    static Task<T> AwaitOp<T>(Windows.Foundation.IAsyncOperation<T> op, int timeoutMs)
    {
        return Task.Run(delegate
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (op.Status == Windows.Foundation.AsyncStatus.Started)
            {
                if (sw.ElapsedMilliseconds > timeoutMs) throw new TimeoutException("WinRT op 超时（" + timeoutMs + "ms）——源未应答");
                Thread.Sleep(4);
            }
            if (op.Status == Windows.Foundation.AsyncStatus.Error) throw new Exception("WinRT op error: " + op.ErrorCode);
            if (op.Status == Windows.Foundation.AsyncStatus.Canceled) throw new Exception("WinRT op canceled");
            return op.GetResults();
        });
    }

    static readonly System.Diagnostics.Stopwatch StopwatchSingleton = System.Diagnostics.Stopwatch.StartNew();

    // Minimal command field extractor: looks for "name":value among string/number/bool fields.
    static string Field(string json, string name)
    {
        string pat = "\"" + name + "\"";
        int i = json.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return null;
        i = json.IndexOf(':', i + pat.Length);
        if (i < 0) return null;
        i++;
        while (i < json.Length && (json[i] == ' ' || json[i] == '\t')) i++;
        if (i >= json.Length) return null;
        if (json[i] == '"')
        {
            var sb = new StringBuilder();
            i++;
            while (i < json.Length && json[i] != '"')
            {
                if (json[i] == '\\' && i + 1 < json.Length)
                {
                    char c = json[i + 1];
                    if (c == 'n') sb.Append('\n');
                    else if (c == 't') sb.Append('\t');
                    else if (c == 'r') sb.Append('\r');
                    else if (c == 'u' && i + 5 < json.Length)
                    {
                        try { sb.Append((char)Convert.ToInt32(json.Substring(i + 2, 4), 16)); i += 4; }
                        catch { }
                    }
                    else sb.Append(c);
                    i += 2;
                }
                else { sb.Append(json[i]); i++; }
            }
            return sb.ToString();
        }
        int j = i;
        while (j < json.Length && ",}] \t\r\n".IndexOf(json[j]) < 0) j++;
        return json.Substring(i, j - i);
    }

    static string KeyFor(GlobalSystemMediaTransportControlsSession s, string aumid)
    {
        int gen;
        if (!genPerAumid.TryGetValue(aumid, out gen)) gen = 0;
        genPerAumid[aumid] = gen + 1;
        return aumid + "#" + gen;
    }

    static async Task<int> Run()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            mgr = await AwaitOp(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
            var ready = "{\"type\":\"ready\",\"ts\":" + JTs() + ",\"requestMs\":" + sw.ElapsedMilliseconds + "}";
            Emit(ready);
            RefreshSessions();
        }
        catch (Exception e)
        {
            Emit("{\"type\":\"fatal\",\"ts\":" + JTs() + ",\"error\":" + Esc(e.ToString()) + "}");
            return 2;
        }

        // stdin loop on threadpool
        var stdinTask = Task.Run((Action)StdinLoop);

        // stdout writer
        while (true)
        {
            outSignal.WaitOne(500);
            string line;
            while (outq.TryDequeue(out line)) Console.WriteLine(line);
            if (stdinDone && outq.IsEmpty) break;
        }
        return 0;
    }

    static volatile bool stdinDone = false;

    static void StdinLoop()
    {
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                Handle(line);
            }
        }
        catch (Exception e)
        {
            Emit("{\"type\":\"fatal\",\"stage\":\"stdin\",\"ts\":" + JTs() + ",\"error\":" + Esc(e.ToString()) + "}");
        }
        stdinDone = true;
        outSignal.Set();
    }

    static void Handle(string line)
    {
        string id = Field(line, "id") ?? "0";
        string cmd = Field(line, "cmd");
        try
        {
            Handle2(id, cmd, line);
        }
        catch (Exception e)
        {
            Emit("{\"type\":\"result\",\"id\":" + Esc(id) + ",\"ok\":false,\"ts\":" + JTs() + ",\"error\":" + Esc(e.ToString()) + "}");
        }
    }

    static void Handle2(string id, string cmd, string line)
    {
        if (cmd == "list")
        {
            Console.Error.WriteLine("[list] enter");
            var keys = KeysSnapshot();
            Console.Error.WriteLine("[list] keys=" + keys.Count);
            var sb = new StringBuilder();
            sb.Append("{\"type\":\"result\",\"id\":").Append(Esc(id)).Append(",\"ok\":true,\"ts\":").Append(JTs())
              .Append(",\"data\":{\"count\":").Append(keys.Count);
            Console.Error.WriteLine("[list] cur begin");
        string cur = CurrentKeyOrNull();
        Console.Error.WriteLine("[list] cur done");
            sb.Append(",\"currentKey\":").Append(cur == null ? "null" : Esc(cur));
            // 工单336：list 直接出全量快照（探针版为 light snap + 单键 snap 两跳；Broker
            // 刷新瀑布一次 list 即得完整 DTO——会话数个位数，暖机后每 snap ms 级）
            sb.Append(",\"sessions\":[");
            bool first = true;
            foreach (string k in keys)
            {
                if (!first) sb.Append(",");
                first = false;
                Console.Error.WriteLine("[list] fullsnap begin " + k);
                sb.Append(FullSnap(k));
                Console.Error.WriteLine("[list] fullsnap done " + k);
            }
            sb.Append("]}}");
            Emit(sb.ToString());
            return;
        }
        if (cmd == "snap")
        {
            string key = Field(line, "key");
            Emit("{\"type\":\"result\",\"id\":" + Esc(id) + ",\"ok\":true,\"ts\":" + JTs() + ",\"data\":" + FullSnap(key) + "}");
            return;
        }
        if (cmd == "thumb")
        {
            string key = Field(line, "key");
            Thumb(id, key);
            return;
        }
        if (cmd == "control")
        {
            string key = Field(line, "key");
            string action = Field(line, "action");
            Control(id, key, action);
            return;
        }
        if (cmd == "watch")
        {
            string on = Field(line, "on");
            bool enable = on == "true";
            SetWatch(enable);
            Emit("{\"type\":\"result\",\"id\":" + Esc(id) + ",\"ok\":true,\"ts\":" + JTs() + ",\"data\":{\"watch\":" + (enable ? "true" : "false") + "}}");
            return;
        }
        Emit("{\"type\":\"result\",\"id\":" + Esc(id) + ",\"ok\":false,\"ts\":" + JTs() + ",\"error\":\"unknown cmd\"}");
    }

    static object keyGate = new object();

    static List<string> KeysSnapshot()
    {
        lock (keyGate)
        {
            return new List<string>(byKey.Keys);
        }
    }

    static GlobalSystemMediaTransportControlsSession ByKeyOrNull(string key)
    {
        lock (keyGate)
        {
            GlobalSystemMediaTransportControlsSession s;
            return byKey.TryGetValue(key, out s) ? s : null;
        }
    }

    static string CurrentKeyOrNull()
    {
        GlobalSystemMediaTransportControlsSession cur;
        try
        {
            // 本 build API 漂移：CurrentSession 是属性（t329 漂移清单）；读挂起按 3s 时限降级 null
            var t = Task.Run(() => mgr.GetCurrentSession());
            if (!t.Wait(3000)) return null;
            cur = t.Result;
        }
        catch { return null; }
        if (cur == null) return null;
        lock (keyGate)
        {
            string k;
            return keyOf.TryGetValue(cur, out k) ? k : null;
        }
    }

    static readonly object refreshLock = new object();
    static void RefreshSessions()
    {
        lock (refreshLock)
        {
        var sessions = mgr.GetSessions();
        var seen = new List<string>();
        var added = new List<string>();
        var removed = new List<string>();
        lock (keyGate)
        {
            var current = new Dictionary<GlobalSystemMediaTransportControlsSession, bool>();
            foreach (var s in sessions) current[s] = true;
            var oldKeys = new List<string>(byKey.Keys);
            foreach (var s in sessions)
            {
                string k;
                if (!keyOf.TryGetValue(s, out k))
                {
                    string aumid = s.SourceAppUserModelId ?? "unknown";
                    k = KeyFor(s, aumid);
                    byKey[k] = s;
                    keyOf[s] = k;
                    Subscribe(s, k);
                    added.Add(k);
                }
                seen.Add(k);
            }
            foreach (string k in oldKeys)
            {
                if (seen.IndexOf(k) < 0)
                {
                    GlobalSystemMediaTransportControlsSession s = byKey[k];
                    Unsubscribe(k);
                    byKey.Remove(k);
                    keyOf.Remove(s);
                    removed.Add(k);
                }
            }
        }
        Emit("{\"type\":\"event\",\"event\":\"sessions-changed\",\"ts\":" + JTs() + ",\"sessions\":[" + Jary(seen) + "]}");
        foreach (string k in added) Emit("{\"type\":\"event\",\"event\":\"session-added\",\"key\":" + Esc(k) + ",\"ts\":" + JTs() + "}");
        foreach (string k in removed) Emit("{\"type\":\"event\",\"event\":\"session-removed\",\"key\":" + Esc(k) + ",\"ts\":" + JTs() + "}");
        }
    }

    static string Jary(List<string> xs)
    {
        var sb = new StringBuilder();
        for (int i = 0; i < xs.Count; i++)
        {
            if (i > 0) sb.Append(",");
            sb.Append(Esc(xs[i]));
        }
        return sb.ToString();
    }

    // After referencing the GAC System.Runtime.InteropServices.WindowsRuntime facade, the
    // projected events compile as real C# events and the compiler manages WinRT event tokens
    // automatically, so += / -= with the same delegate instance work for unsubscribe.
    static TypedEventHandler<GlobalSystemMediaTransportControlsSessionManager, CurrentSessionChangedEventArgs> curHandler;
    static TypedEventHandler<GlobalSystemMediaTransportControlsSessionManager, SessionsChangedEventArgs> sessHandler;
    static readonly Dictionary<string, TypedEventHandler<GlobalSystemMediaTransportControlsSession, MediaPropertiesChangedEventArgs>> hMedia =
        new Dictionary<string, TypedEventHandler<GlobalSystemMediaTransportControlsSession, MediaPropertiesChangedEventArgs>>();
    static readonly Dictionary<string, TypedEventHandler<GlobalSystemMediaTransportControlsSession, PlaybackInfoChangedEventArgs>> hPlayback =
        new Dictionary<string, TypedEventHandler<GlobalSystemMediaTransportControlsSession, PlaybackInfoChangedEventArgs>>();
    static readonly Dictionary<string, TypedEventHandler<GlobalSystemMediaTransportControlsSession, TimelinePropertiesChangedEventArgs>> hTimeline =
        new Dictionary<string, TypedEventHandler<GlobalSystemMediaTransportControlsSession, TimelinePropertiesChangedEventArgs>>();

    static void SetWatch(bool enable)
    {
        lock (gate)
        {
            if (enable == watching) return;
            watching = enable;
            if (enable)
            {
                curHandler = new TypedEventHandler<GlobalSystemMediaTransportControlsSessionManager, CurrentSessionChangedEventArgs>(OnCurrentSessionChanged);
                sessHandler = new TypedEventHandler<GlobalSystemMediaTransportControlsSessionManager, SessionsChangedEventArgs>(OnSessionsChanged);
                mgr.CurrentSessionChanged += curHandler;
                mgr.SessionsChanged += sessHandler;
            }
            else
            {
                mgr.CurrentSessionChanged -= curHandler;
                mgr.SessionsChanged -= sessHandler;
            }
        }
    }

    static void OnCurrentSessionChanged(GlobalSystemMediaTransportControlsSessionManager m, CurrentSessionChangedEventArgs args)
    {
        string k = CurrentKeyOrNull();
        Emit("{\"type\":\"event\",\"event\":\"current-session-changed\",\"key\":" + (k == null ? "null" : Esc(k)) + ",\"ts\":" + JTs() + "}");
    }

    static void OnSessionsChanged(GlobalSystemMediaTransportControlsSessionManager m, SessionsChangedEventArgs args)
    {
        RefreshSessions();
    }

    static void Subscribe(GlobalSystemMediaTransportControlsSession s, string k)
    {
        var m1 = new TypedEventHandler<GlobalSystemMediaTransportControlsSession, MediaPropertiesChangedEventArgs>((ss, a) => EmitSessionEvent(k, "media"));
        var m2 = new TypedEventHandler<GlobalSystemMediaTransportControlsSession, PlaybackInfoChangedEventArgs>((ss, a) => EmitSessionEvent(k, "playback"));
        var m3 = new TypedEventHandler<GlobalSystemMediaTransportControlsSession, TimelinePropertiesChangedEventArgs>((ss, a) => EmitSessionEvent(k, "timeline"));
        s.MediaPropertiesChanged += m1;
        s.PlaybackInfoChanged += m2;
        s.TimelinePropertiesChanged += m3;
        lock (keyGate) { hMedia[k] = m1; hPlayback[k] = m2; hTimeline[k] = m3; }
    }

    static void Unsubscribe(string k)
    {
        GlobalSystemMediaTransportControlsSession s;
        bool has = false;
        lock (keyGate) { has = byKey.TryGetValue(k, out s); }
        if (!has) return;
        TypedEventHandler<GlobalSystemMediaTransportControlsSession, MediaPropertiesChangedEventArgs> m1 = null;
        TypedEventHandler<GlobalSystemMediaTransportControlsSession, PlaybackInfoChangedEventArgs> m2 = null;
        TypedEventHandler<GlobalSystemMediaTransportControlsSession, TimelinePropertiesChangedEventArgs> m3 = null;
        bool got = false;
        lock (keyGate)
        {
            got = hMedia.TryGetValue(k, out m1) && hPlayback.TryGetValue(k, out m2) && hTimeline.TryGetValue(k, out m3);
        }
        if (got)
        {
            try { s.MediaPropertiesChanged -= m1; } catch { }
            try { s.PlaybackInfoChanged -= m2; } catch { }
            try { s.TimelinePropertiesChanged -= m3; } catch { }
        }
        lock (keyGate) { hMedia.Remove(k); hPlayback.Remove(k); hTimeline.Remove(k); }
    }

    static void EmitSessionEvent(string k, string what)
    {
        Emit("{\"type\":\"event\",\"event\":\"session-updated\",\"key\":" + Esc(k) + ",\"what\":" + Esc(what) + ",\"ts\":" + JTs() + "}");
    }

    static string LightSnap(string k)
    {
        var s = ByKeyOrNull(k);
        if (s == null) return "{\"key\":" + Esc(k) + ",\"gone\":true}";
        Console.Error.WriteLine("[snap] pb begin " + k);
        var pb = s.GetPlaybackInfo();
        Console.Error.WriteLine("[snap] tl begin");
        var c = pb.Controls;
        string aumid = s.SourceAppUserModelId ?? "unknown";
        return "{\"key\":" + Esc(k) + ",\"aumid\":" + Esc(aumid)
            + ",\"status\":\"" + pb.PlaybackStatus.ToString() + "\""
            + ",\"caps\":{\"play\":" + B(c.IsPlayEnabled) + ",\"pause\":" + B(c.IsPauseEnabled)
            + ",\"next\":" + B(c.IsNextEnabled) + ",\"previous\":" + B(c.IsPreviousEnabled)
            + ",\"stop\":" + B(c.IsStopEnabled) + "}}";
    }

    static string B(bool b) { return b ? "true" : "false"; }

    static string FullSnap(string k)
    {
        // 工单336 韧性：同步 WinRT 读（GetPlaybackInfo/GetTimelineProperties）对行为异常源同样
        // 会挂——整个 snap 体上 3s 硬时限，超时回落 mediaUnavailable（桥不挂、其余会话照常）
        var body = Task.Run(() => FullSnapBody(k));
        if (!body.Wait(3000))
        {
            return "{\"key\":" + Esc(k) + ",\"mediaUnavailable\":true}";
        }
        return body.Result;
    }

    static string FullSnapBody(string k)
    {
        var s = ByKeyOrNull(k);
        if (s == null) return "{\"key\":" + Esc(k) + ",\"gone\":true}";
        var pb = s.GetPlaybackInfo();
        Console.Error.WriteLine("[snap] tl begin");
        var c = pb.Controls;
        var tl = s.GetTimelineProperties();
        string aumid = s.SourceAppUserModelId ?? "unknown";
        var sb = new StringBuilder();
        sb.Append("{\"key\":").Append(Esc(k)).Append(",\"aumid\":").Append(Esc(aumid));
        sb.Append(",\"status\":\"").Append(pb.PlaybackStatus.ToString()).Append("\"");
        sb.Append(",\"caps\":{\"play\":").Append(B(c.IsPlayEnabled)).Append(",\"pause\":").Append(B(c.IsPauseEnabled))
          .Append(",\"next\":").Append(B(c.IsNextEnabled)).Append(",\"previous\":").Append(B(c.IsPreviousEnabled))
          .Append(",\"stop\":").Append(B(c.IsStopEnabled)).Append("}");
        sb.Append(",\"timeline\":{\"positionMs\":").Append(tl.Position.TotalMilliseconds.ToString("0.##"))
          .Append(",\"endTimeMs\":").Append(tl.EndTime.TotalMilliseconds.ToString("0.##"))
          .Append(",\"minSeekMs\":").Append(tl.MinSeekTime.TotalMilliseconds.ToString("0.##"))
          .Append(",\"maxSeekMs\":").Append(tl.MaxSeekTime.TotalMilliseconds.ToString("0.##"))
          // 工单336：epoch ms（跨进程绝对时钟——包页 position+lastUpdatedTime 插值直接可用）
          .Append(",\"lastUpdatedTimeMs\":").Append(tl.LastUpdatedTime.ToUnixTimeMilliseconds())
          .Append(",\"nowMs\":").Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
          .Append("}");
        Console.Error.WriteLine("[snap] mp begin");
        GlobalSystemMediaTransportControlsSessionMediaProperties mp;
        try
        {
            mp = AwaitOp(s.TryGetMediaPropertiesAsync()).GetAwaiter().GetResult();
            lock (mediaCache) { mediaCache[k] = mp; }
        }
        catch
        {
            // 源未应答：回落最近一次成功缓存（无缓存=占位 unknown——桥不挂、其余会话照常）
            GlobalSystemMediaTransportControlsSessionMediaProperties cached = null;
            lock (mediaCache) { if (!mediaCache.TryGetValue(k, out cached)) cached = null; }
            mp = cached;
            if (mp == null) return "{\"key\":" + Esc(k) + ",\"mediaUnavailable\":true}";
        }
        Console.Error.WriteLine("[snap] mp done");
        sb.Append(",\"media\":{\"title\":").Append(Esc(mp.Title)).Append(",\"artist\":").Append(Esc(mp.Artist))
          .Append(",\"albumTitle\":").Append(Esc(mp.AlbumTitle)).Append(",\"albumArtist\":").Append(Esc(mp.AlbumArtist))
          .Append(",\"subtitle\":").Append(Esc(mp.Subtitle));
        sb.Append(",\"genres\":[");
        for (int i = 0; i < mp.Genres.Count; i++) { if (i > 0) sb.Append(","); sb.Append(Esc(mp.Genres[i])); }
        sb.Append("],\"playType\":\"").Append(mp.PlaybackType.ToString()).Append("\"");
        sb.Append(",\"trackNumber\":").Append(mp.TrackNumber).Append(",\"albumTrackCount\":").Append(mp.AlbumTrackCount);
        sb.Append(",\"thumbPresent\":").Append(mp.Thumbnail != null ? "true" : "false");
        sb.Append("}}");
        return sb.ToString();
    }

    static async void Thumb(string id, string k)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var s = ByKeyOrNull(k);
            if (s == null) throw new Exception("session key gone: " + k);
            var mp = await AwaitOp(s.TryGetMediaPropertiesAsync());
            if (mp.Thumbnail == null)
            {
                Emit("{\"type\":\"result\",\"id\":" + Esc(id) + ",\"ok\":true,\"ts\":" + JTs() + ",\"data\":{\"present\":false}}");
                return;
            }
            var stream = await AwaitOp(mp.Thumbnail.OpenReadAsync());
            long size = (long)stream.Size;
            string contentType = stream.ContentType;
            var reader = new DataReader(stream);
            uint loaded = await AwaitOp(reader.LoadAsync((uint)size));
            var bytes = new byte[loaded];
            if (loaded > 0) reader.ReadBytes(bytes);
            reader.DetachStream();
            reader.Dispose();
            stream.Dispose(); // close native stream: bytes remain panel-owned
            sw.Stop();
            var sb = new StringBuilder();
            sb.Append("{\"type\":\"result\",\"id\":").Append(Esc(id)).Append(",\"ok\":true,\"ts\":").Append(JTs())
              .Append(",\"data\":{\"present\":true,\"contentType\":").Append(Esc(contentType))
              .Append(",\"declaredSize\":").Append(size)
              .Append(",\"readBytes\":").Append(bytes.Length)
              .Append(",\"ms\":").Append(sw.ElapsedMilliseconds);
            sb.Append(",\"headHex\":\"");
            int n = bytes.Length < 8 ? bytes.Length : 8;
            for (int i = 0; i < n; i++) sb.Append(bytes[i].ToString("x2"));
            sb.Append("\",\"bytesBase64\":\"").Append(Convert.ToBase64String(bytes)).Append("\"}}");
            Emit(sb.ToString());
        }
        catch (Exception e)
        {
            Emit("{\"type\":\"result\",\"id\":" + Esc(id) + ",\"ok\":false,\"ts\":" + JTs() + ",\"error\":" + Esc(e.ToString()) + "}");
        }
    }

    static async void Control(string id, string key, string action)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var s = ByKeyOrNull(key);
            if (s == null) throw new Exception("session key gone: " + key);
            var caps = s.GetPlaybackInfo().Controls;
            bool enabled;
            Func<Task<bool>> op;
            if (action == "play") { enabled = caps.IsPlayEnabled; op = () => AwaitOp(s.TryPlayAsync()); }
            else if (action == "pause") { enabled = caps.IsPauseEnabled; op = () => AwaitOp(s.TryPauseAsync()); }
            else if (action == "toggle") { enabled = caps.IsPlayEnabled || caps.IsPauseEnabled; op = () => AwaitOp(s.TryTogglePlayPauseAsync()); }
            else if (action == "next") { enabled = caps.IsNextEnabled; op = () => AwaitOp(s.TrySkipNextAsync()); }
            else if (action == "previous") { enabled = caps.IsPreviousEnabled; op = () => AwaitOp(s.TrySkipPreviousAsync()); }
            else throw new Exception("unknown action " + action);

            string before = s.GetPlaybackInfo().PlaybackStatus.ToString();
            if (!enabled)
            {
                Emit("{\"type\":\"result\",\"id\":" + Esc(id) + ",\"ok\":true,\"ts\":" + JTs() +
                     ",\"data\":{\"action\":" + Esc(action) + ",\"capabilityAllowed\":false,\"attempted\":false,\"delivered\":false,\"statusBefore\":\"" + before + "\",\"statusAfter\":\"" + before + "\",\"statusChanged\":false,\"elapsedMs\":" + sw.ElapsedMilliseconds + "}}");
                return;
            }
            bool delivered = await op();
            string after = before;
            bool changed = false;
            long changeMs = -1;
            for (int i = 0; i < 20; i++)
            {
                await Task.Delay(100);
                string now = s.GetPlaybackInfo().PlaybackStatus.ToString();
                if (now != before) { after = now; changed = true; changeMs = sw.ElapsedMilliseconds; break; }
            }
            if (!changed) after = s.GetPlaybackInfo().PlaybackStatus.ToString();
            Emit("{\"type\":\"result\",\"id\":" + Esc(id) + ",\"ok\":true,\"ts\":" + JTs() +
                 ",\"data\":{\"action\":" + Esc(action) + ",\"capabilityAllowed\":true,\"attempted\":true,\"delivered\":" + B(delivered) +
                 ",\"statusBefore\":\"" + before + "\",\"statusAfter\":\"" + after + "\",\"statusChanged\":" + B(changed) +
                 ",\"statusChangeMs\":" + changeMs + ",\"elapsedMs\":" + sw.ElapsedMilliseconds + "}}");
        }
        catch (Exception e)
        {
            Emit("{\"type\":\"result\",\"id\":" + Esc(id) + ",\"ok\":false,\"ts\":" + JTs() + ",\"error\":" + Esc(e.ToString()) + "}");
        }
    }

    static int Main(string[] args)
    {
        var enc = new UTF8Encoding(false);
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), enc) { AutoFlush = true });
        return Run().GetAwaiter().GetResult();
    }
}
