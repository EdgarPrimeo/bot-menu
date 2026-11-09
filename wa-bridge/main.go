// wa-bridge : petit pont WhatsApp (whatsmeow) piloté par le bot Node.
//
// Protocole : une ligne JSON par message.
//   stdout → événements vers Node   ({"type":"qr"|"pairing_code"|"connected"|"message"|...})
//   stdin  ← commandes depuis Node  ({"cmd":"send","id":"1","to":"<jid ou numéro>","text":"..."})
//
// Sécurité :
//   - seuls les numéros de WA_ALLOWED_NUMBERS sont transmis à Node, et seuls eux peuvent recevoir un envoi
//     (double contrôle : même si Node demandait autre chose, le pont refuse) ;
//   - le pont n'exécute rien et n'ouvre aucun fichier sur la base du contenu d'un message ;
//   - aucun contenu de message n'est journalisé (les journaux d'erreur sont expurgés des numéros).
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite" // SQLite 100 % Go : compilation croisée sans compilateur C (CGO_ENABLED=0)
)

const maxMessageAge = 2 * time.Hour

var (
	outMu   sync.Mutex
	digits  = regexp.MustCompile(`\d{6,}`)
	allowed = map[string]bool{}
)

// emit écrit un événement JSON sur stdout (une ligne).
func emit(v map[string]any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	outMu.Lock()
	defer outMu.Unlock()
	os.Stdout.Write(append(b, '\n'))
}

func redact(s string) string {
	s = digits.ReplaceAllString(s, "•••")
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// Journal whatsmeow : seulement avertissements et erreurs, expurgés, transmis à Node comme événements "log".
type bridgeLog struct{ module string }

func (l bridgeLog) Errorf(msg string, args ...any) {
	emit(map[string]any{"type": "log", "level": "error", "msg": redact(l.module + ": " + fmt.Sprintf(msg, args...))})
}
func (l bridgeLog) Warnf(msg string, args ...any) {
	emit(map[string]any{"type": "log", "level": "warn", "msg": redact(l.module + ": " + fmt.Sprintf(msg, args...))})
}
func (l bridgeLog) Infof(string, ...any)       {}
func (l bridgeLog) Debugf(string, ...any)      {}
func (l bridgeLog) Sub(m string) waLog.Logger { return bridgeLog{module: l.module + "/" + m} }

type bridge struct {
	cli         *whatsmeow.Client
	pairingNum  string
	ctx         context.Context
}

// phoneOf renvoie le numéro (partie utilisateur d'un JID téléphone) d'un JID, en résolvant les identifiants masqués (LID).
func (b *bridge) phoneOf(jid types.JID, alt types.JID) string {
	if jid.Server == types.DefaultUserServer {
		return jid.User
	}
	if alt.Server == types.DefaultUserServer {
		return alt.User
	}
	if jid.Server == types.HiddenUserServer {
		if pn, err := b.cli.Store.LIDs.GetPNForLID(b.ctx, jid.ToNonAD()); err == nil && !pn.IsEmpty() {
			return pn.User
		}
	}
	return ""
}

func (b *bridge) onEvent(evt any) {
	switch e := evt.(type) {
	case *events.Connected:
		emit(map[string]any{"type": "connected"})
	case *events.Disconnected:
		emit(map[string]any{"type": "disconnected"})
	case *events.PairSuccess:
		emit(map[string]any{"type": "pair_success"})
	case *events.LoggedOut:
		emit(map[string]any{"type": "logged_out", "reason": e.Reason.String()})
	case *events.StreamReplaced:
		emit(map[string]any{"type": "stream_replaced"})
	case *events.TemporaryBan:
		emit(map[string]any{"type": "temporary_ban", "reason": e.String()})
	case *events.ConnectFailure:
		emit(map[string]any{"type": "connect_failure", "reason": e.Reason.String()})
	case *events.ClientOutdated:
		emit(map[string]any{"type": "client_outdated"})
	case *events.Message:
		b.onMessage(e)
	}
}

func (b *bridge) onMessage(e *events.Message) {
	info := e.Info
	if info.IsFromMe || info.IsGroup || info.Chat.IsBroadcastList() || info.Chat.Server != types.DefaultUserServer && info.Chat.Server != types.HiddenUserServer {
		return
	}
	if time.Since(info.Timestamp) > maxMessageAge {
		return
	}
	phone := b.phoneOf(info.Sender, info.SenderAlt)
	if phone == "" || !allowed[phone] {
		emit(map[string]any{"type": "ignored"}) // aucun détail : expéditeur hors liste blanche
		return
	}
	msg := e.Message
	text := msg.GetConversation()
	if text == "" {
		text = msg.GetExtendedTextMessage().GetText()
	}
	kind := "text"
	if text == "" {
		kind = "other"
	}
	emit(map[string]any{
		"type": "message", "kind": kind, "number": phone, "chat": info.Chat.String(),
		"id": info.ID, "text": text, "ts": info.Timestamp.Unix(),
	})
}

// resolveTarget transforme la cible demandée en JID, et vérifie qu'elle est dans la liste blanche.
func (b *bridge) resolveTarget(to string) (types.JID, error) {
	var jid types.JID
	if strings.Contains(to, "@") {
		parsed, err := types.ParseJID(to)
		if err != nil {
			return jid, errors.New("JID invalide")
		}
		jid = parsed.ToNonAD()
	} else {
		jid = types.NewJID(strings.TrimPrefix(to, "+"), types.DefaultUserServer)
	}
	if b.phoneOf(jid, types.EmptyJID) == "" || !allowed[b.phoneOf(jid, types.EmptyJID)] {
		return jid, errors.New("destinataire hors liste blanche : envoi refusé")
	}
	return jid, nil
}

func (b *bridge) handleCommands() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	for sc.Scan() {
		var cmd struct {
			Cmd  string `json:"cmd"`
			ID   string `json:"id"`
			To   string `json:"to"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(sc.Bytes(), &cmd); err != nil {
			continue
		}
		switch cmd.Cmd {
		case "send":
			go b.send(cmd.ID, cmd.To, cmd.Text)
		}
	}
	// stdin fermé : Node s'est arrêté, on s'arrête aussi.
	b.cli.Disconnect()
	os.Exit(0)
}

func (b *bridge) send(id, to, text string) {
	fail := func(err error) {
		emit(map[string]any{"type": "send_result", "id": id, "ok": false, "error": redact(err.Error())})
	}
	if strings.TrimSpace(text) == "" || len(text) > 4000 {
		fail(errors.New("texte vide ou trop long"))
		return
	}
	if !b.cli.IsConnected() || !b.cli.IsLoggedIn() {
		fail(errors.New("WhatsApp non connecté"))
		return
	}
	jid, err := b.resolveTarget(to)
	if err != nil {
		fail(err)
		return
	}
	ctx, cancel := context.WithTimeout(b.ctx, 30*time.Second)
	defer cancel()
	if _, err := b.cli.SendMessage(ctx, jid, &waE2E.Message{Conversation: proto.String(text)}); err != nil {
		fail(err)
		return
	}
	emit(map[string]any{"type": "send_result", "id": id, "ok": true})
}

// pair relie l'appareil (QR ou code d'appairage). Recommence tant que l'appareil n'est pas relié, avec un plafond.
func (b *bridge) pair() {
	for attempt := 1; attempt <= 5; attempt++ {
		qrChan, err := b.cli.GetQRChannel(b.ctx)
		if err != nil {
			emit(map[string]any{"type": "pair_error", "error": redact(err.Error())})
			return
		}
		if err := b.cli.Connect(); err != nil {
			emit(map[string]any{"type": "pair_error", "error": redact(err.Error())})
			time.Sleep(10 * time.Second)
			continue
		}
		codeRequested := false
		for item := range qrChan {
			switch item.Event {
			case whatsmeow.QRChannelEventCode:
				if b.pairingNum == "" {
					emit(map[string]any{"type": "qr", "code": item.Code})
				} else if !codeRequested {
					codeRequested = true
					code, err := b.cli.PairPhone(b.ctx, b.pairingNum, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
					if err != nil {
						emit(map[string]any{"type": "pair_error", "error": redact(err.Error())})
					} else {
						emit(map[string]any{"type": "pairing_code", "code": code})
					}
				}
			case whatsmeow.QRChannelEventPasskeyRequest:
				emit(map[string]any{"type": "passkey_required"})
			case whatsmeow.QRChannelEventError:
				emit(map[string]any{"type": "pair_error", "error": redact(fmt.Sprint(item.Error))})
			case whatsmeow.QRChannelSuccess.Event:
				return // PairSuccess puis Connected arrivent par les événements
			case whatsmeow.QRChannelTimeout.Event:
				emit(map[string]any{"type": "pair_timeout", "attempt": attempt})
			default:
				emit(map[string]any{"type": "pair_error", "error": item.Event})
			}
		}
		b.cli.Disconnect()
		if b.cli.Store.ID != nil {
			return
		}
		time.Sleep(5 * time.Second)
	}
	emit(map[string]any{"type": "pair_giveup"})
}

func main() {
	for _, n := range strings.Split(os.Getenv("WA_ALLOWED_NUMBERS"), ",") {
		if n = strings.TrimSpace(n); n != "" {
			allowed[n] = true
		}
	}
	if len(allowed) == 0 {
		emit(map[string]any{"type": "fatal", "error": "WA_ALLOWED_NUMBERS vide"})
		os.Exit(1)
	}
	dbPath := os.Getenv("WA_DB_PATH")
	if dbPath == "" {
		dbPath = "session/wa.db"
	}

	ctx := context.Background()
	store.SetOSInfo("Menu du soir", [3]uint32{1, 0, 0})
	container, err := sqlstore.New(ctx, "sqlite", "file:"+dbPath+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_txlock=immediate", bridgeLog{"db"})
	if err != nil {
		emit(map[string]any{"type": "fatal", "error": redact(err.Error())})
		os.Exit(1)
	}
	os.Chmod(dbPath, 0o600)
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		emit(map[string]any{"type": "fatal", "error": redact(err.Error())})
		os.Exit(1)
	}

	b := &bridge{cli: whatsmeow.NewClient(device, bridgeLog{"client"}), pairingNum: os.Getenv("WA_PAIRING_NUMBER"), ctx: ctx}
	b.cli.AddEventHandler(b.onEvent)
	go b.handleCommands()

	if device.ID == nil {
		go b.pair()
	} else if err := b.cli.Connect(); err != nil {
		emit(map[string]any{"type": "log", "level": "error", "msg": redact(err.Error())})
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	b.cli.Disconnect()
}
