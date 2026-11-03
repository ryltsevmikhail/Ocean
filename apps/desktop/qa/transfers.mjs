export async function checkTransfers(page, button, image) {
  await page.evaluate((data) => {
    const clipboard = new globalThis.DataTransfer();
    clipboard.items.add(
      new globalThis.File(
        [Uint8Array.from(globalThis.atob(data), (c) => c.charCodeAt(0))],
        'pasted.png',
        {
          type: 'image/png',
        },
      ),
    );
    globalThis.document.querySelector('#composer').dispatchEvent(
      new globalThis.ClipboardEvent('paste', {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, image.toString('base64'));
  await button('Предпросмотр pasted.png').locator('img').waitFor();
  await button('Убрать pasted.png').click();
  await page.evaluate(() => {
    const transfer = new globalThis.DataTransfer();
    transfer.items.add(
      new globalThis.File(['Dropped content'], 'dropped.txt', { type: 'text/plain' }),
    );
    globalThis.document.querySelector('#composer').dispatchEvent(
      new globalThis.DragEvent('drop', {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await button('Убрать dropped.txt').click();
  await page.waitForFunction(
    () => !globalThis.document.querySelector('[aria-label="Прикрепить файл"]').disabled,
  );
}
