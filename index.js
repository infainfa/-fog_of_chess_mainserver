const { createServer } = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { FogEngine } = require('./fogEngine');

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*' } });

const games = new Map();
let waitingPlayer = null;

// ═══════════════════════════════════════════════════════
// HARDCORE FOG OF WAR
//
// Гравець може ходити будь-якою фігурою навіть під шахом.
// Перемога = взяття короля суперника.
//
// Хак: щоб обійти блокування chess.js під шахом —
// перемикаємо чергу ходів в FEN на суперника,
// виконуємо хід "за нього", потім повертаємо стан.
// ═══════════════════════════════════════════════════════

function kingExists(chess, color) {
  for (const row of chess.board())
    for (const piece of row)
      if (piece && piece.type === 'k' && piece.color === color) return true;
  return false;
}

// Перевіряємо чи фігура на клітинці `from` може фізично
// дійти до `to` — без урахування шаху.
// Робимо це через тимчасову Chess де черга ходів — суперника,
// і пробуємо хід "від імені" суперника.
function isMovePhysicallyPossible(chess, from, to, promotion) {
  const piece = chess.get(from);
  if (!piece) return false;

  // Спочатку пробуємо звичайний хід
  const tempNormal = new Chess(chess.fen());
  try {
    const m = tempNormal.move({ from, to, promotion: promotion || 'q' });
    if (m) return true;
  } catch {}

  // Якщо заблокований через шах — пробуємо хак через FEN
  // Міняємо чергу ходів в FEN на протилежну і виконуємо хід
  const fen = chess.fen();
  const fenParts = fen.split(' ');
  const currentColor = fenParts[1]; // 'w' або 'b'
  fenParts[1] = currentColor === 'w' ? 'b' : 'w'; // міняємо чергу
  const flippedFen = fenParts.join(' ');

  try {
    const tempFlipped = new Chess(flippedFen);
    // Тепер "суперник" ходить нашою фігурою — chess.js не блокує
    const m = tempFlipped.move({ from, to, promotion: promotion || 'q' });
    if (m) return true;
  } catch {}

  return false;
}

// Виконуємо хід на реальній дошці — обходячи блокування шаху
function forceMove(chess, from, to, promotion) {
  // Спочатку звичайний спосіб
  try {
    const m = chess.move({ from, to, promotion: promotion || 'q' });
    if (m) return m;
  } catch {}

  // Якщо заблокований — використовуємо FEN хак
  const fen = chess.fen();
  const fenParts = fen.split(' ');
  const currentColor = fenParts[1];
  fenParts[1] = currentColor === 'w' ? 'b' : 'w';
  const flippedFen = fenParts.join(' ');

  try {
    const tempChess = new Chess(flippedFen);
    const m = tempChess.move({ from, to, promotion: promotion || 'q' });
    if (!m) return null;

    // Відновлюємо правильну чергу ходів в новому FEN
    const newFen = tempChess.fen().split(' ');
    newFen[1] = currentColor === 'w' ? 'b' : 'w'; // тепер хід суперника
    // Скидаємо лічильник напівходів і повний хід якщо треба
    chess.load(newFen.join(' '));
    return { from, to, promotion: promotion || 'q' };
  } catch(e) {
    console.error('forceMove error:', e.message);
    return null;
  }
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on('find_game', () => {
    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      const gameId = `g_${Date.now()}`;
      const chess  = new Chess();
      const fog    = new FogEngine();

      games.set(gameId, { chess, fog, players: { white: waitingPlayer.id, black: socket.id } });
      waitingPlayer.join(gameId);
      socket.join(gameId);

      const sendStart = (s, color) => s.emit('game_start', {
        gameId, color,
        board:          fog.filterBoard(chess.board(), color === 'white' ? 'w' : 'b'),
        visibleSquares: [...fog.getVisibleSquares(chess.board(), color === 'white' ? 'w' : 'b')],
        turn: 'white',
      });

      sendStart(waitingPlayer, 'white');
      sendStart(socket, 'black');
      waitingPlayer = null;
    } else {
      waitingPlayer = socket;
      socket.emit('waiting');
    }
  });

  socket.on('make_move', ({ gameId, from, to, promotion }) => {
    const game = games.get(gameId);
    if (!game) return;
    const { chess, fog, players } = game;

    const currentTurn = chess.turn();
    if (socket.id !== (currentTurn === 'w' ? players.white : players.black))
      return socket.emit('error', { message: 'Not your turn' });

    // Перевіряємо чи хід фізично можливий (без урахування шаху)
    if (!isMovePhysicallyPossible(chess, from, to, promotion))
      return socket.emit('error', { message: 'Invalid move' });

    // Виконуємо хід — обходячи блокування шаху
    const move = forceMove(chess, from, to, promotion);
    if (!move)
      return socket.emit('error', { message: 'Move failed' });

    // Перемога = король суперника взятий
    const opponentColor = currentTurn === 'w' ? 'b' : 'w';
    const kingCaptured  = !kingExists(chess, opponentColor);

    const isStalemate = !kingCaptured && chess.isStalemate();
    const isDraw      = !kingCaptured && !isStalemate && chess.isDraw();
    const isGameOver  = kingCaptured || isStalemate || isDraw;
    const winner      = kingCaptured
      ? (currentTurn === 'w' ? 'white' : 'black')
      : null;

    const base = {
      move:        { from: move.from || from, to: move.to || to },
      turn:        chess.turn() === 'w' ? 'white' : 'black',
      isGameOver,
      isCheckmate: kingCaptured,
      isStalemate,
      winner,
    };

    for (const [id, fogColor] of [[players.white, 'w'], [players.black, 'b']]) {
      const s = io.sockets.sockets.get(id);
      if (s) s.emit('move_made', {
        ...base,
        board:          fog.filterBoard(chess.board(), fogColor),
        visibleSquares: [...fog.getVisibleSquares(chess.board(), fogColor)],
      });
    }

    if (isGameOver) setTimeout(() => games.delete(gameId), 30000);
  });

  socket.on('resign', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game) return;
    const winner = game.players.white === socket.id ? 'black' : 'white';
    io.to(gameId).emit('game_over', { reason: 'resign', winner });
    games.delete(gameId);
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    if (waitingPlayer?.id === socket.id) waitingPlayer = null;
    for (const [gameId, { players }] of games.entries()) {
      if (players.white === socket.id || players.black === socket.id) {
        io.to(gameId).emit('game_over', {
          reason: 'disconnect',
          winner: players.white === socket.id ? 'black' : 'white',
        });
        games.delete(gameId);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`♟ Chess server :${PORT}`));
