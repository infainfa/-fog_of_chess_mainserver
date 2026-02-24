const { createServer } = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { FogEngine } = require('./fogEngine');

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*' } });

const games = new Map();
let waitingPlayer = null;

// ═══════════════════════════════════════════════════════════════
// Власний генератор ходів — ігнорує правило шаху
// Перемога = взяття короля суперника
// ═══════════════════════════════════════════════════════════════

const FILES = ['a','b','c','d','e','f','g','h'];
const DIRS = {
  r: [[1,0],[-1,0],[0,1],[0,-1]],
  b: [[1,1],[1,-1],[-1,1],[-1,-1]],
  q: [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],
  n: [[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]],
  k: [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],
};

function sq(f, r) { return FILES[f] + (r + 1); }

// Повертає всі фізично можливі ходи БЕЗ перевірки шаху
function getAllMoves(chess, color) {
  const moves = [];
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const square = sq(file, rank);
      const piece  = chess.get(square);
      if (!piece || piece.color !== color) continue;

      if (piece.type === 'p') {
        const dir   = color === 'w' ? 1 : -1;
        const start = color === 'w' ? 1 : 6;
        const r1    = rank + dir;
        if (r1 >= 0 && r1 < 8) {
          const fwd = sq(file, r1);
          if (!chess.get(fwd)) {
            moves.push({ from: square, to: fwd });
            if (rank === start) {
              const fwd2 = sq(file, rank + dir * 2);
              if (!chess.get(fwd2)) moves.push({ from: square, to: fwd2 });
            }
          }
          for (const df of [-1, 1]) {
            const ff = file + df;
            if (ff >= 0 && ff < 8) {
              const diag   = sq(ff, r1);
              const target = chess.get(diag);
              if (target && target.color !== color) moves.push({ from: square, to: diag });
              const ep = chess.fen().split(' ')[3];
              if (ep && ep !== '-' && ep === diag) moves.push({ from: square, to: diag });
            }
          }
        }
      } else if (piece.type === 'n') {
        for (const [df, dr] of DIRS.n) {
          const nf = file + df, nr = rank + dr;
          if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
          const target = chess.get(sq(nf, nr));
          if (!target || target.color !== color) moves.push({ from: square, to: sq(nf, nr) });
        }
      } else if (piece.type === 'k') {
        // Звичайні ходи короля
        for (const [df, dr] of DIRS.k) {
          const nf = file + df, nr = rank + dr;
          if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
          const target = chess.get(sq(nf, nr));
          if (!target || target.color !== color) moves.push({ from: square, to: sq(nf, nr) });
        }
        // Рокіровка — дозволяємо навіть під шахом
        const castling  = chess.fen().split(' ')[2];
        const kingRank  = color === 'w' ? 0 : 7;
        if (rank === kingRank && file === 4) {
          // Коротка (e→g)
          if (castling.includes(color === 'w' ? 'K' : 'k')
            && !chess.get(sq(5, kingRank))
            && !chess.get(sq(6, kingRank))) {
            moves.push({ from: square, to: sq(6, kingRank) });
          }
          // Довга (e→c)
          if (castling.includes(color === 'w' ? 'Q' : 'q')
            && !chess.get(sq(3, kingRank))
            && !chess.get(sq(2, kingRank))
            && !chess.get(sq(1, kingRank))) {
            moves.push({ from: square, to: sq(2, kingRank) });
          }
        }
      } else {
        for (const [df, dr] of DIRS[piece.type]) {
          let nf = file + df, nr = rank + dr;
          while (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7) {
            const target = chess.get(sq(nf, nr));
            if (target) {
              if (target.color !== color) moves.push({ from: square, to: sq(nf, nr) });
              break;
            }
            moves.push({ from: square, to: sq(nf, nr) });
            nf += df; nr += dr;
          }
        }
      }
    }
  }
  return moves;
}

function kingExists(chess, color) {
  for (const row of chess.board())
    for (const piece of row)
      if (piece && piece.type === 'k' && piece.color === color) return true;
  return false;
}

// Виконує хід навіть якщо chess.js блокує через шах
function forceMove(chess, from, to, promotion) {
  // Спробуємо звичайний спосіб
  try {
    const m = chess.move({ from, to, promotion: promotion || 'q' });
    if (m) return m;
  } catch {}

  // chess.js блокує через шах — маніпулюємо FEN напряму
  const board    = chess.board();
  const fen      = chess.fen();
  const parts    = fen.split(' ');
  const turn     = parts[1];
  const FILES    = ['a','b','c','d','e','f','g','h'];
  const fromFile = FILES.indexOf(from[0]);
  const fromRank = parseInt(from[1]) - 1;
  const toFile   = FILES.indexOf(to[0]);
  const toRank   = parseInt(to[1]) - 1;

  const newBoard = board.map(row => [...row]);
  const movedPiece = newBoard[7 - fromRank][fromFile];
  if (!movedPiece) return null;

  newBoard[7 - fromRank][fromFile] = null;

  // Промоція пішака
  if (movedPiece.type === 'p' && (toRank === 7 || toRank === 0)) {
    newBoard[7 - toRank][toFile] = { type: promotion || 'q', color: movedPiece.color };
  } else {
    newBoard[7 - toRank][toFile] = { ...movedPiece };
  }

  // Дошка -> FEN рядок
  const fenRows = newBoard.map(row => {
    let s = ''; let empty = 0;
    for (const cell of row) {
      if (!cell) { empty++; }
      else {
        if (empty > 0) { s += empty; empty = 0; }
        s += cell.color === 'w' ? cell.type.toUpperCase() : cell.type;
      }
    }
    if (empty > 0) s += empty;
    return s;
  }).join('/');

  const newTurn   = turn === 'w' ? 'b' : 'w';
  const halfMove  = movedPiece.type === 'p' ? '0' : String(parseInt(parts[4] || '0') + 1);
  const fullMove  = turn === 'b' ? String(parseInt(parts[5] || '1') + 1) : (parts[5] || '1');
  const newFen    = `${fenRows} ${newTurn} - - ${halfMove} ${fullMove}`;

  try {
    chess.load(newFen);
    console.log(`[forceMove ok] ${from}->${to} newTurn=${newTurn}`);
    return { from, to };
  } catch(e) {
    console.error('[forceMove] load failed:', e.message, newFen);
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

    // Валідуємо через власний генератор (без перевірки шаху)
    const allMoves = getAllMoves(chess, currentTurn);
    const isValid  = allMoves.some(m => m.from === from && m.to === to);
    console.log(`[move] ${from}->${to} turn=${currentTurn} valid=${isValid} fen=${chess.fen()}`);
    if (!isValid) return socket.emit('error', { message: 'Invalid move' });

    // Виконуємо хід (форсуємо якщо chess.js блокує)
    const move = forceMove(chess, from, to, promotion);
    console.log(`[after move] result=${JSON.stringify(move)} newFen=${chess.fen()}`);
    if (!move) return socket.emit('error', { message: 'Move failed' });

    // Перемога = король суперника взятий
    const opponentColor = currentTurn === 'w' ? 'b' : 'w';
    const kingCaptured  = !kingExists(chess, opponentColor);
    const isStalemate   = !kingCaptured && chess.isStalemate();
    const isDraw        = !kingCaptured && !isStalemate && chess.isDraw();
    const isGameOver    = kingCaptured || isStalemate || isDraw;
    const winner        = kingCaptured ? (currentTurn === 'w' ? 'white' : 'black') : null;

    const base = {
      move:        { from: move.from || from, to: move.to || to },
      fen:         chess.fen(),
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
