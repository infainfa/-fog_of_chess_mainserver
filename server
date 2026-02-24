const { createServer } = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { FogEngine } = require('./fogEngine');

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*' } });

const games = new Map();
let waitingPlayer = null;

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on('find_game', () => {
    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      const gameId = `g_${Date.now()}`;
      const chess = new Chess();
      const fog = new FogEngine();

      games.set(gameId, { chess, fog, players: { white: waitingPlayer.id, black: socket.id } });
      waitingPlayer.join(gameId);
      socket.join(gameId);

      const sendStart = (s, color) => s.emit('game_start', {
        gameId, color,
        board: fog.filterBoard(chess.board(), color === 'white' ? 'w' : 'b'),
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
      return socket.emit('error', { message: 'Не ваш хід' });

    let move;
    try { move = chess.move({ from, to, promotion: promotion || 'q' }); }
    catch { return socket.emit('error', { message: 'Невалідний хід' }); }
    if (!move) return socket.emit('error', { message: 'Невалідний хід' });

    const isGameOver = chess.isGameOver();
    const isCheckmate = chess.isCheckmate();

    // HARDCORE FOG: isCheck навмисно не відправляємо
    const base = {
      move: { from: move.from, to: move.to },
      turn: chess.turn() === 'w' ? 'white' : 'black',
      isGameOver, isCheckmate,
      winner: isCheckmate ? (currentTurn === 'w' ? 'white' : 'black') : null,
    };

    for (const [id, fogColor] of [[players.white, 'w'], [players.black, 'b']]) {
      const s = io.sockets.sockets.get(id);
      if (s) s.emit('move_made', {
        ...base,
        board: fog.filterBoard(chess.board(), fogColor),
        visibleSquares: [...fog.getVisibleSquares(chess.board(), fogColor)],
      });
    }

    if (isGameOver) setTimeout(() => games.delete(gameId), 30000);
  });

  socket.on('get_moves', ({ gameId, square }) => {
    const game = games.get(gameId);
    if (!game) return;
    const { chess, fog, players } = game;
    const color = players.white === socket.id ? 'w' : 'b';

    if (!fog.getVisibleSquares(chess.board(), color).has(square))
      return socket.emit('valid_moves', { moves: [] });

    socket.emit('valid_moves', {
      moves: chess.moves({ square, verbose: true }).map(m => m.to)
    });
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
