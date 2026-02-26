const { createServer } = require('http');
const { Server }       = require('socket.io');
const { Chess }        = require('chess.js');
const { FogEngine }    = require('./fogEngine');

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*' } });

const games = new Map();
let waitingPlayer = null;

const FILES = ['a','b','c','d','e','f','g','h'];
const DIRS  = {
  r: [[1,0],[-1,0],[0,1],[0,-1]],
  b: [[1,1],[1,-1],[-1,1],[-1,-1]],
  q: [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],
  n: [[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]],
  k: [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]],
};

function sq(f, r) { return FILES[f] + (r + 1); }

// Всі фізично можливі ходи без перевірки шаху + рокіровка
function getAllMoves(chess, color) {
  const moves    = [];
  const fen      = chess.fen().split(' ');
  const epSquare = fen[3];
  const castling = fen[2];

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
              if (epSquare && epSquare !== '-' && epSquare === diag) moves.push({ from: square, to: diag });
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
        // Звичайні ходи
        for (const [df, dr] of DIRS.k) {
          const nf = file + df, nr = rank + dr;
          if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
          const target = chess.get(sq(nf, nr));
          if (!target || target.color !== color) moves.push({ from: square, to: sq(nf, nr) });
        }
        // Рокіровка (дозволяємо навіть під шахом)
        const kr = color === 'w' ? 0 : 7;
        if (rank === kr && file === 4) {
          if (castling.includes(color === 'w' ? 'K' : 'k')
            && !chess.get(sq(5, kr)) && !chess.get(sq(6, kr)))
            moves.push({ from: square, to: sq(6, kr) });
          if (castling.includes(color === 'w' ? 'Q' : 'q')
            && !chess.get(sq(3, kr)) && !chess.get(sq(2, kr)) && !chess.get(sq(1, kr)))
            moves.push({ from: square, to: sq(2, kr) });
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
    for (const p of row)
      if (p && p.type === 'k' && p.color === color) return true;
  return false;
}

// Виконує хід — спочатку через chess.js, при блокуванні через шах — через FEN
function applyMove(chess, from, to, promotion) {
  // Визначаємо чи це рокіровка ДО спроби chess.js
  // щоб знати як обробляти якщо chess.js заблокує
  const isCastling = chess.get(from)?.type === 'k' && Math.abs(FILES.indexOf(to[0]) - FILES.indexOf(from[0])) === 2;

  // chess.js вміє рокіровку і en passant — пробуємо спочатку
  try {
    const m = chess.move({ from, to, promotion: promotion || 'q' });
    if (m) return true;
  } catch {}

  // Заблоковано через шах — будуємо FEN вручну
  const board    = chess.board();
  const fenParts = chess.fen().split(' ');
  const turn     = fenParts[1];
  const fromFile = FILES.indexOf(from[0]);
  const fromRank = parseInt(from[1]) - 1;
  const toFile   = FILES.indexOf(to[0]);
  const toRank   = parseInt(to[1]) - 1;

  const piece = board[7 - fromRank][fromFile];
  if (!piece) return false;

  const nb = board.map(row => row.map(p => p ? { ...p } : null));
  nb[7 - fromRank][fromFile] = null;

  // Промоція
  if (piece.type === 'p' && (toRank === 7 || toRank === 0)) {
    nb[7 - toRank][toFile] = { type: promotion || 'q', color: piece.color };
  } else {
    nb[7 - toRank][toFile] = { ...piece };
  }

  // Рокіровка — переміщуємо туру вручну
  if (isCastling) {
    const kr = turn === 'w' ? 0 : 7;
    if (toFile === 6) {
      // Коротка: тура h→f
      nb[7 - kr][5] = nb[7 - kr][7];
      nb[7 - kr][7] = null;
    } else if (toFile === 2) {
      // Довга: тура a→d
      nb[7 - kr][3] = nb[7 - kr][0];
      nb[7 - kr][0] = null;
    }
  }

  // En passant
  const ep = fenParts[3];
  if (piece.type === 'p' && ep && ep !== '-' && ep === to) {
    const epRank = turn === 'w' ? toRank - 1 : toRank + 1;
    nb[7 - epRank][toFile] = null;
  }

  // Права рокіровки — скидаємо якщо король або тура рухались
  let newCastling = fenParts[2];
  if (piece.type === 'k') {
    newCastling = newCastling.replace(turn === 'w' ? /[KQ]/g : /[kq]/g, '');
  }
  if (from === 'h1' || to === 'h1') newCastling = newCastling.replace('K', '');
  if (from === 'a1' || to === 'a1') newCastling = newCastling.replace('Q', '');
  if (from === 'h8' || to === 'h8') newCastling = newCastling.replace('k', '');
  if (from === 'a8' || to === 'a8') newCastling = newCastling.replace('q', '');
  if (!newCastling) newCastling = '-';

  const newEp    = piece.type === 'p' && Math.abs(toRank - fromRank) === 2
    ? sq(fromFile, fromRank + (turn === 'w' ? 1 : -1)) : '-';
  const newTurn  = turn === 'w' ? 'b' : 'w';
  const halfMove = (piece.type === 'p' || nb[7-toRank][toFile]) ? '0'
    : String(parseInt(fenParts[4] || '0') + 1);
  const fullMove = turn === 'b'
    ? String(parseInt(fenParts[5] || '1') + 1) : (fenParts[5] || '1');

  const pos = nb.map(row => {
    let s = ''; let e = 0;
    for (const cell of row) {
      if (!cell) { e++; }
      else { if (e) { s += e; e = 0; } s += cell.color === 'w' ? cell.type.toUpperCase() : cell.type; }
    }
    if (e) s += e;
    return s;
  }).join('/');

  const newFen = `${pos} ${newTurn} ${newCastling} ${newEp} ${halfMove} ${fullMove}`;
  console.log(`[applyMove forced] ${from}->${to} fen=${newFen}`);

  try {
    chess.load(newFen);
    return true;
  } catch(e) {
    console.error('[applyMove] load failed:', e.message, newFen);
    return false;
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

    const allMoves = getAllMoves(chess, currentTurn);
    const isValid  = allMoves.some(m => m.from === from && m.to === to);
    console.log(`[move] ${from}->${to} turn=${currentTurn} valid=${isValid}`);
    if (!isValid) return socket.emit('error', { message: 'Invalid move' });

    // Визначаємо збиту фігуру ДО ходу
    const capturedPiece = chess.get(to);

    const ok = applyMove(chess, from, to, promotion);
    console.log(`[after] ok=${ok} fen=${chess.fen()}`);
    if (!ok) return socket.emit('error', { message: 'Move failed' });

    const opponentColor = currentTurn === 'w' ? 'b' : 'w';
    const kingCaptured  = !kingExists(chess, opponentColor);
    const isStalemate   = !kingCaptured && chess.isStalemate();
    const isDraw        = !kingCaptured && !isStalemate && chess.isDraw();
    const isGameOver    = kingCaptured || isStalemate || isDraw;
    const winner        = kingCaptured ? (currentTurn === 'w' ? 'white' : 'black') : null;

    const base = {
      move: { from, to, captured: capturedPiece ? capturedPiece.type : null },
      fen:  chess.fen(),
      turn: chess.turn() === 'w' ? 'white' : 'black',
      isGameOver, isCheckmate: kingCaptured, isStalemate, winner,
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
httpServer.listen(PORT, () => console.log(`♟ Chess server :${PORT} [v3-castling-fix]`));
