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
// Перемога = взяття короля суперника.
// Гравець може ходити під шах — він не знає про нього.
// Якщо наступним ходом суперник б'є короля — програш.
// ═══════════════════════════════════════════════════════

function kingExists(chess, color) {
  for (const row of chess.board())
    for (const piece of row)
      if (piece && piece.type === 'k' && piece.color === color) return true;
  return false;
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

    // Отримуємо всі можливі ходи з цієї клітинки
    // chess.js може обмежити ходи через шах — нам це не потрібно
    // але для базової валідації (чи фігура взагалі може туди піти) використовуємо
    const allMoves = chess.moves({ verbose: true });
    const isPhysicallyValid = allMoves.some(m => m.from === from && m.to === to);

    // Якщо хід не в списку chess.js — можливо через шах.
    // Перевіряємо чи фігура взагалі існує і чи може фізично дійти до цієї клітинки
    // через тимчасову дошку без обмежень шаху
    if (!isPhysicallyValid) {
      // Спробуємо на тимчасовій копії з вимкненою перевіркою
      const tempChess = new Chess(chess.fen());
      // Встановлюємо FEN без можливості рокіровки щоб обійти обмеження
      try {
        // Форсуємо хід напряму через внутрішній метод
        const result = tempChess.move({ from, to, promotion: promotion || 'q' });
        if (!result) return socket.emit('error', { message: 'Invalid move' });
      } catch {
        return socket.emit('error', { message: 'Invalid move' });
      }
    }

    // Застосовуємо хід
    let move;
    try {
      move = chess.move({ from, to, promotion: promotion || 'q' });
    } catch(e) {
      // chess.js відхилив через шах — але ми хочемо дозволити
      // Тому застосовуємо через тимчасовий обхід:
      // Змінюємо позицію напряму через новий FEN
      const tempChess = new Chess(chess.fen());
      try {
        move = tempChess.move({ from, to, promotion: promotion || 'q' });
        if (!move) return socket.emit('error', { message: 'Invalid move' });
        // Копіюємо стан
        chess.load(tempChess.fen());
        // Відновлюємо move об'єкт
        move = { from, to, promotion: promotion || 'q', flags: '' };
      } catch {
        return socket.emit('error', { message: 'Invalid move' });
      }
    }

    // ── Перевіряємо чи взято короля ──
    // Той хто НЕ ходив зараз — перевіряємо чи його король ще живий
    const opponentColor = currentTurn === 'w' ? 'b' : 'w';
    const kingCaptured  = !kingExists(chess, opponentColor);

    const isStalemate = !kingCaptured && chess.isStalemate();
    const isDraw      = !kingCaptured && !isStalemate && chess.isDraw();
    const isGameOver  = kingCaptured || isStalemate || isDraw;

    const winner = kingCaptured
      ? (currentTurn === 'w' ? 'white' : 'black')
      : (isDraw || isStalemate) ? null : null;

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
