// @ts-check
import EventEmitter from 'events'
import { Readable } from 'streamx'
// @ts-ignore
import { chunkStoreRead } from 'chunk-store-iterator'
import mime from 'mime/lite.js'
import FileIterator from './file-iterator.js'

/**
 * @typedef { import("./torrent.js").default } Torrent
 */

/**
 * Webtorrent Files closely mimic W3C Files/Blobs, except for slice, where instead you pass the offsets as objects to the arrayBuffer/stream/createReadStream functions.
 */
export default class File extends EventEmitter {
  /**
   * @param {Torrent} torrent
   * @param {File} file
   */
  constructor (torrent, file) {
    super()

    /**
     * `null` if the file has been destroyed
     * @type {Torrent?}
     **/
    this._torrent = torrent
    this._destroyed = false

    /** @type {Set<Readable>} */
    this._fileStreams = new Set()
    /** @type {Set<FileIterator>} */
    this._iterators = new Set()

    /**
     * File name, as specified by the torrent.
     * @type {string}
     * @example 'some-filename.txt'
     **/
    this.name = file.name

    /**
     * File path, as specified by the torrent.
     * @type {string}
     * @example 'some-folder/some-filename.txt'
     **/
    this.path = file.path

    /**
     * File length (in bytes), as specified by the torrent.
     * Same value as `File.size`
     * @type {number}
     * @example 12345
     **/
    this.length = file.length

    /**
     * File length (in bytes), as specified by the torrent.
     * Same value as `File.length`
     * @type {number}
     * @example 12345
     **/
    this.size = file.length

    /**
     * Mime type of the file, falls back to `application/octet-stream` if the type is not recognized.
     * @type {string}
     **/
    this.type = mime.getType(this.name) || 'application/octet-stream'

    /** @type {number} */
    this.offset = file.offset

    this.done = false

    const start = file.offset
    const end = start + file.length - 1

    this._startPiece = start / this._torrent.pieceLength | 0
    this._endPiece = end / this._torrent.pieceLength | 0

    if (this.length === 0) {
      this.done = true
      this.emit('done')
    }

    this._client = torrent.client
  }

  /**
   * Total *verified* bytes received from peers, for this file.
   * @returns {number}
   */
  get downloaded () {
    if (this._destroyed || !this._torrent || !this._torrent.bitfield) return 0

    const { pieces, bitfield, pieceLength, lastPieceLength } = this._torrent
    const { _startPiece: start, _endPiece: end } = this

    const getPieceLength = (/** @type {number} */ pieceIndex) => (
      pieceIndex === pieces.length - 1 ? lastPieceLength : pieceLength
    )

    const getPieceDownloaded = (/** @type {number} */ pieceIndex) => {
      const len = pieceIndex === pieces.length - 1 ? lastPieceLength : pieceLength
      if (bitfield.get(pieceIndex)) {
        // verified data
        return len
      } else {
        // "in progress" data
        return len - pieces[pieceIndex].missing
      }
    }

    let downloaded = 0
    for (let index = start; index <= end; index += 1) {
      const pieceDownloaded = getPieceDownloaded(index)
      downloaded += pieceDownloaded

      if (index === start) {
        // First piece may have an offset, e.g. irrelevant bytes from the end of
        // the previous file
        const irrelevantFirstPieceBytes = this.offset % pieceLength
        downloaded -= Math.min(irrelevantFirstPieceBytes, pieceDownloaded)
      }

      if (index === end) {
        // Last piece may have an offset, e.g. irrelevant bytes from the start
        // of the next file
        const irrelevantLastPieceBytes = getPieceLength(end) - (this.offset + this.length) % pieceLength
        downloaded -= Math.min(irrelevantLastPieceBytes, pieceDownloaded)
      }
    }

    return downloaded
  }

  /**
   * File download progress, from 0 to 1.
   * @returns {number}
   **/
  get progress () {
    return this.length ? this.downloaded / this.length : 0
  }

  /**
   * Selects the file to be downloaded, at the given `priority`. Useful if you know you need the file at a later stage.
   * @param {number} priority
   * @returns {void}
   */
  select (priority) {
    if (this.length === 0) return
    this._torrent?.select(this._startPiece, this._endPiece, priority)
  }

  /**
   * Deselects the file's specific priority, which means it won't be downloaded unless someone creates a stream for it.
   * @returns {void}
   **/
  deselect () {
    if (this.length === 0) return
    this._torrent?.deselect(this._startPiece, this._endPiece)
  }

  /**
  * @typedef FileIteratorOpts
  * @prop {number=} start start byte, inclusive
  * @prop {number=} end end byte, inclusive
  */

  /**
   * Create an async iterator to the file.
   * Pieces needed by the stream will be prioritized highly and fetched from the swarm first.
   * @param {FileIteratorOpts=} opts options to iterate only a slice of a file.
   * @returns {AsyncGenerator<void, void> | FileIterator} TODO chunkStoreRead
   *
   * @example
   * ```js
   * for await (const chunk of file) {
   *   // do something with chunk
   * }
   * ```
   */
  [Symbol.asyncIterator] (opts = {}) {
    if (this.length === 0 || !this._torrent) return (async function * empty () {})()

    const { start = 0 } = opts ?? {}
    const end = (opts?.end && opts.end < this.length)
      ? opts.end
      : this.length - 1

    if (this.done) {
      return chunkStoreRead(this._torrent.store, { offset: start + this.offset, length: end - start + 1 })
    }

    const iterator = new FileIterator(this, { start, end })
    this._iterators.add(iterator)
    iterator.once('return', () => {
      this._iterators.delete(iterator)
    })

    return iterator
  }

  /**
   * Create a readable stream to the file.
   * Pieces needed by the stream will be prioritized highly and fetched from the swarm first.
   * @param {FileIteratorOpts=} opts options to stream only a slice of a file.
   * @returns {Readable}
   *
   * @see https://nodejs.org/api/stream.html#stream_class_stream_readable
   */
  createReadStream (opts) {
    const iterator = this[Symbol.asyncIterator](opts)
    const fileStream = Readable.from(iterator)

    this._fileStreams.add(fileStream)
    fileStream.once('close', () => {
      this._fileStreams.delete(fileStream)
    })

    return fileStream
  }

  /**
   * Get the file contents as an `ArrayBuffer`
   * @param {FileIteratorOpts=} opts options to only get part of an `ArrayBuffer`
   * @returns {Promise<ArrayBufferLike>}
   */
  async arrayBuffer (opts = {}) {
    const { start = 0 } = opts
    const end = (opts?.end && opts.end < this.length)
      ? opts.end
      : this.length - 1

    const data = new Uint8Array(end - start + 1)
    let offset = 0
    for await (const chunk of this[Symbol.asyncIterator]({ start, end })) {
      data.set(chunk, offset)
      offset += chunk.length
    }
    return data.buffer
  }

  /**
   * Get a W3C Blob object which contains the file data.
   * The file will be fetched from the network with highest priority.
   * @param {FileIteratorOpts=} opts options to get only a part of a Blob.
   * @returns {Promise<Blob>}
   */
  async blob (opts) {
    return new Blob([await this.arrayBuffer(opts)], { type: this.type })
  }

  /**
   * Create a W3C ReadableStream to the file. Pieces needed by the stream will be prioritized highly and fetched from the swarm first.
   * @param {FileIteratorOpts=} opts - options to stream only a slice of a file.
   * @returns {ReadableStream}
   */
  stream (opts) {
    /** @type {AsyncGenerator<void, void> | FileIterator} */
    let iterator
    return new ReadableStream({
      start: () => {
        iterator = this[Symbol.asyncIterator](opts)
      },
      async pull (controller) {
        const { value, done } = await iterator.next()
        if (done) {
          controller.close()
        } else {
          controller.enqueue(value)
        }
      },
      cancel () {
        iterator.return()
      }
    })
  }

  /**
   *
   * @returns {string} the stream URL
   *
   * @example Creating a file download link:
   *
   * ```js
   * const a = document.createElement('a')
   * a.target = "_blank"
   * a.href = file.streamUrl
   * a.textContent = 'Download ' + file.name
   * document.body.append(a)
   * ```
   */
  get streamURL () {
    if (!this._client._server) throw new Error('No server created')
    return `${this._client._server.pathname}/${this._torrent?.infoHash}/${this.path}`
  }

  /**
   * Sets the element source to the file's streaming URL. Supports streaming, seeking and all browser codecs and containers.
   * Requires `client.createServer` to be ran beforehand.
   *
   * Support table:
   *
   * Requires `client.createServer` to be ran beforehand. Sets the element source to the file's streaming URL. Supports streaming, seeking and all browser codecs and containers.
   *
   * Support table:
   * |Containers|Chromium|Mobile Chromium|Edge|Chrome|Firefox|
   * |-|:-:|:-:|:-:|:-:|:-:|
   * |3g2|✓|✓|✓|✓|✓|
   * |3gp|✓|✓|✓|✓|✘|
   * |avi|✘|✘|✘|✘|✘|
   * |m2ts|✘|✘|✓**|✘|✘|
   * |m4v etc.|✓*|✓*|✓*|✓*|✓*|
   * |mp4|✓|✓|✓|✓|✓|
   * |mpeg|✘|✘|✘|✘|✘|
   * |mov|✓|✓|✓|✓|✓|
   * |ogm ogv|✓|✓|✓|✓|✓|
   * |webm|✓|✓|✓|✓|✓|
   * |mkv|✓|✓|✓|✓|✘|
   *
   * \* Container might be supported, but the container's codecs might not be.
   * \*\* Documented as working, but can't reproduce.
   *
   * |Video Codecs|Chromium|Mobile Chromium|Edge|Chrome|Firefox|
   * |-|:-:|:-:|:-:|:-:|:-:|
   * |AV1|✓|✓|✓|✓|✓|
   * |H.263|✘|✘|✘|✘|✘|
   * |H.264|✓|✓|✓|✓|✓|
   * |H.265|✘|✘|✓*|✓|✘|
   * |MPEG-2/4|✘|✘|✘|✘|✘|
   * |Theora|✓|✘|✓|✓|✓|
   * |VP8/9|✓|✓|✓|✓|✓|
   *
   * \* Requires MSStore extension which you can get by opening this link `ms-windows-store://pdp/?ProductId=9n4wgh0z6vhq` while using Edge.
   *
   * |Audio Codecs|Chromium|Mobile Chromium|Edge|Chrome|Firefox|
   * |-|:-:|:-:|:-:|:-:|:-:|
   * |AAC|✓|✓|✓|✓|✓|
   * |AC3|✘|✘|✓|✘|✘|
   * |DTS|✘|✘|✘|✘|✘|
   * |EAC3|✘|✘|✓|✘|✘|
   * |FLAC|✓|✓*|✓|✓|✓|
   * |MP3|✓|✓|✓|✓|✓|
   * |Opus|✓|✓|✓|✓|✓|
   * |TrueHD|✘|✘|✘|✘|✘|
   * |Vorbis|✓|✓|✓|✓|✓*|
   *
   * \* Might not work in some video containers.
   *
   * Since container and codec support is browser dependent these values might change over time.
   *
   * @param {HTMLVideoElement} elem
   * @returns {HTMLVideoElement} the passed element
   */
  streamTo (elem) {
    elem.src = this.streamURL
    return elem
  }

  /**
   * Check if the piece number contains this file's data.
   * @param {number} piece
   * @returns {boolean}
   */
  includes (piece) {
    return this._startPiece <= piece && this._endPiece >= piece
  }

  /**
   * Mark the file as destroyed.
   * @returns {void}
   * @private
   */
  _destroy () {
    this._destroyed = true
    this._torrent = null

    for (const fileStream of this._fileStreams) {
      fileStream.destroy()
    }
    this._fileStreams.clear()
    for (const iterator of this._iterators) {
      iterator.destroy()
    }
    this._iterators.clear()
  }
}
