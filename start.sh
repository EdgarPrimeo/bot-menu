#!/bin/bash
# Lance le bot dans une session tmux « menu » (utilisateur wabot).
#   Démarrer :  ~/bot/start.sh
#   Voir :      tmux attach -t menu      (puis Ctrl-b d pour quitter sans arrêter)
#   Arrêter :   tmux kill-session -t menu
set -euo pipefail
umask 077
cd "$(dirname "$0")"

if [ "$(id -un)" != "wabot" ]; then echo "À lancer en tant que wabot (sudo -iu wabot)." >&2; exit 1; fi
if tmux has-session -t menu 2>/dev/null; then echo "Déjà lancé : tmux attach -t menu"; exit 0; fi

# Le bot est le premier processus que Linux sacrifie si la mémoire manque (protège le collecteur bid/ask),
# et il redémarre tout seul en cas de plantage (pause de 10 s).
tmux new-session -d -s menu "bash -c '
  echo 1000 > /proc/self/oom_score_adj
  export TZ=Europe/Paris PATH=\$HOME/.local/node/bin:/usr/bin:/bin
  while true; do
    node --disable-warning=ExperimentalWarning --max-old-space-size=160 src/index.js
    echo \"Bot arrêté (code \$?). Redémarrage dans 10 s… (Ctrl-C pour arrêter)\"
    sleep 10
  done'"
echo "Bot lancé dans tmux. Pour voir : tmux attach -t menu"
