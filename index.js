const { createServer } = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { FogEngine } = require('./fogEngine');

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*' } });

const games = new Map();
let waitingPlayer = null;

// ═══════════════════════════════════════════════════════════════
// HARDCORE FOG OF WAR — без правил шаху
//
// chess.js v1.x: moves({ legal: false }) повертає всі фізичні
// ходи без перевірки чи залишає король під шахом.
// Перемога = взяття короля суперника наступним ходом.
// ═══════════════════════════════════════════════════════════════

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

    // Перевіряємо що хід фізично можливий (legal: false = ігноруємо шах)
    const allMoves = chess.moves({ verbose: true, legal: false });
    const isValid  = allMoves.some(m => m.from === from && m.to === to);

    if (!isValid)
      return socket.emit('error', { message: 'Invalid move' });

    // Виконуємо хід — якщо chess.js блокує через шах,
    // завантажуємо позицію напряму через FEN маніпуляцію
    let move;
    try {
      move = chess.move({ from, to, promotion: promotion || 'q' });
    } catch {
      move = null;
    }

    if (!move) {
      // Форсуємо хід через прямий запис у FEN
      const board = chess.board();
      const piece = board.flat().find(p => p && squareToCoords(p.square).join('') === squareToCoords(from).join(''));
      
      // Використовуємо альтернативний підхід — міняємо turn в FEN
      const fenParts = chess.fen().split(' ');
      const realTurn = fenParts[1];
      fenParts[1] = realTurn === 'w' ? 'b' : 'w';
      
      try {
        const tempChess = new Chess(fenParts.join(' '));
        const tempMove  = tempChess.move({ from, to, promotion: promotion || 'q' });
        if (!tempMove) return socket.emit('error', { message: 'Move failed' });
        
        // Відновлюємо правильний turn
        const newFen = tempChess.fen().split(' ');
        newFen[1] = realTurn === 'w' ? 'b' : 'w';
        chess.load(newFen.join(' '));
        move = { from, to, promotion: promotion || 'q' };
      } catch(e) {
        return socket.emit('error', { message: 'Move failed: ' + e.message });
      }
    }

    // Перемога = взяття короля суперника
    const opponentColor = currentTurn === 'w' ? 'b' : 'w';
    const kingCaptured  = !kingExists(chess, opponentColor);
    const isStalemate   = !kingCaptured && chess.isStalemate();
    const isDraw        = !kingCaptured && !isStalemate && chess.isDraw();
    const isGameOver    = kingCaptured || isStalemate || isDraw;
    const winner        = kingCaptured ? (currentTurn === 'w' ? 'white' : 'black') : null;

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

function squareToCoords(sq) {
  return [sq.charCodeAt(0) - 97, parseInt(sq[1]) - 1];
}

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`♟ Chess server :${PORT}`));
