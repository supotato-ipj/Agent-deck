// t336 SMTC 源夹具 v2-final（MediaPlayer 直构——v3 的 DispatcherQueue 改写破坏 SMTC 注册，
// 回滚到两次定谳成功的 v2 结构；桥侧超时韧性已补，源偶发不响应由桥 3s 超时兜住不挂死）。
// 排障全记录 spec326-notes/t336-media/：隔离 Edge 首跑态压制 SMTC、用户 Edge 运行实例不吃
// autoplay 旗标、.NET IInspectable 裸 vtable interop NRE、DispatcherQueue 改写反致注册失效。
// stdio：{"type":"ready"} / "stop" → Pause + 退出 0。
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Media;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Storage;
using Windows.Storage.Streams;

static class Fixture
{
    public static MediaPlayer Player;
    public static string WavPath;
    public static string ArtPath;

    static Task<T> AwaitOp<T>(IAsyncOperation<T> op)
    {
        return Task.Run(delegate
        {
            while (op.Status == AsyncStatus.Started) Thread.Sleep(4);
            if (op.Status == AsyncStatus.Error) throw new Exception("WinRT op error: " + op.ErrorCode);
            return op.GetResults();
        });
    }

    public static async void StartPlayback()
    {
        var wavFile = await AwaitOp(StorageFile.GetFileFromPathAsync(WavPath));
        var artFile = await AwaitOp(StorageFile.GetFileFromPathAsync(ArtPath));
        var source = MediaSource.CreateFromStorageFile(wavFile);
        var item = new MediaPlaybackItem(source);
        var props = item.GetDisplayProperties();
        props.Type = MediaPlaybackType.Music;
        props.MusicProperties.Title = "T336 Accept Track";
        props.MusicProperties.Artist = "Deck Accept Artist";
        props.MusicProperties.AlbumTitle = "T336";
        try { props.Thumbnail = RandomAccessStreamReference.CreateFromFile(artFile); } catch { /* 缩略图缺席可表示 */ }
        item.ApplyDisplayProperties(props); // 本 build API：要传回 props（无参重载不存在——t329 漂移清单同族）
        Player.Source = item;
        Player.Play();
        Player.MediaEnded += delegate { Player.Play(); }; // 循环
    }
}

static class Program
{
    static void Main(string[] args)
    {
        Fixture.WavPath = args.Length > 0 ? args[0] : "tone.wav";
        Fixture.ArtPath = args.Length > 1 ? args[1] : "art.png";
        var enc = new UTF8Encoding(false);
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), enc) { AutoFlush = true });
        Fixture.Player = new MediaPlayer();
        Fixture.Player.CommandManager.IsEnabled = true; // SMTC 注册开关（默认真，显式声明立场）
        Fixture.Player.AudioCategory = MediaPlayerAudioCategory.Media;
        Fixture.StartPlayback();
        Console.WriteLine("{\"type\":\"ready\"}");
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            if (line.Trim() == "stop")
            {
                try { Fixture.Player.Pause(); } catch { }
                Console.WriteLine("{\"type\":\"stopped\"}");
                Environment.Exit(0);
            }
        }
    }
}
