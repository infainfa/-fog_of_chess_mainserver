/**
 * FogEngine — логіка туману війни.
 *
 * Пішак бачить:
 * - Клітинку прямо перед собою (якщо вільна)
 * - Другу клітинку вперед (якщо стартова позиція і обидві вільні)
 * - Діагоналі ТІЛЬКИ якщо там стоїть ворожа фігура
 */

class FogEngine {
  getVisibleSquares(board, color) {
    const visible = new Set();
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = board[rank][file];
        if (!piece || piece.color !== color) continue;
        visible.add(this._sq(file, rank));
        this._getAttacks(board, file, rank, piece, color).forEach(sq => visible.add(sq));
      }
    }
    return visible;
  }

  filterBoard(board, color) {
    const visible = this.getVisibleSquares(board, color);
    return board.map((rank, ri) =>
      rank.map((piece, fi) => visible.has(this._sq(fi, ri)) ? piece : undefined)
    );
  }

  _sq(file, rank) {
    return 'abcdefgh'[file] + (8 - rank);
  }

  _inBounds(f, r) {
    return f >= 0 && f < 8 && r >= 0 && r < 8;
  }

  _getAttacks(board, file, rank, piece, color) {
    switch (piece.type) {
      case 'p': return this._pawnVision(board, file, rank, color);
      case 'n': return this._knight(file, rank);
      case 'b': return this._slide(board, file, rank, [[1,1],[1,-1],[-1,1],[-1,-1]]);
      case 'r': return this._slide(board, file, rank, [[1,0],[-1,0],[0,1],[0,-1]]);
      case 'q': return [
        ...this._slide(board, file, rank, [[1,1],[1,-1],[-1,1],[-1,-1]]),
        ...this._slide(board, file, rank, [[1,0],[-1,0],[0,1],[0,-1]]),
      ];
      case 'k': return this._king(file, rank);
      default:  return [];
    }
  }

  _pawnVision(board, file, rank, color) {
    const squares = [];
    const dir = color === 'w' ? -1 : 1;
    const opp = color === 'w' ? 'b' : 'w';
    const startRank = color === 'w' ? 6 : 1;
    const front = rank + dir;

    // Вперед: тільки якщо клітинка вільна
    if (this._inBounds(file, front) && !board[front][file]) {
      squares.push(this._sq(file, front));
      // Друга клітинка: тільки зі стартової і якщо обидві вільні
      const front2 = rank + 2 * dir;
      if (rank === startRank && this._inBounds(file, front2) && !board[front2][file]) {
        squares.push(this._sq(file, front2));
      }
    }

    // Діагоналі: ТІЛЬКИ якщо там стоїть ворожа фігура
    for (const df of [-1, 1]) {
      if (this._inBounds(file + df, front)) {
        const target = board[front][file + df];
        if (target && target.color === opp) {
          squares.push(this._sq(file + df, front));
        }
      }
    }

    return squares;
  }

  _knight(file, rank) {
    return [[-2,-1],[-2,1],[2,-1],[2,1],[-1,-2],[-1,2],[1,-2],[1,2]]
      .filter(([df,dr]) => this._inBounds(file+df, rank+dr))
      .map(([df,dr]) => this._sq(file+df, rank+dr));
  }

  _king(file, rank) {
    return [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]
      .filter(([df,dr]) => this._inBounds(file+df, rank+dr))
      .map(([df,dr]) => this._sq(file+df, rank+dr));
  }

  _slide(board, file, rank, dirs) {
    const squares = [];
    for (const [df,dr] of dirs) {
      let f = file+df, r = rank+dr;
      while (this._inBounds(f, r)) {
        squares.push(this._sq(f, r));
        if (board[r][f]) break;
        f+=df; r+=dr;
      }
    }
    return squares;
  }
}

module.exports = { FogEngine };
