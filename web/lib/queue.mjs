// N08: 연습 서버는 순차 처리(한 번에 연결 하나)이고 수신 중 유휴 제한이 없다.
// 웹 백엔드가 서버로 가는 모든 일(요청 전송, N07 평가)을 이 큐로 한 줄에 세운다.
export class BusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "BusyError";
  }
}

export function createSerialQueue({ maxPending = 8 } = {}) {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    get pending() {
      return pending;
    },
    /** job을 앞선 일이 모두 끝난 뒤에 실행한다. 대기가 maxPending을 넘으면 BusyError로 거절한다. */
    run(job) {
      if (pending >= maxPending) {
        return Promise.reject(new BusyError(`대기 중인 요청이 너무 많습니다 (최대 ${maxPending}개).`));
      }
      pending += 1;
      const result = tail.then(() => job());
      tail = result.then(() => undefined, () => undefined);
      return result.finally(() => {
        pending -= 1;
      });
    },
  };
}
