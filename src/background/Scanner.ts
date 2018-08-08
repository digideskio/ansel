import { BrowserWindow } from 'electron'
import * as sharp from 'sharp'
import * as libraw from 'libraw'
import * as fs from 'fs'
import * as moment from 'moment'
import * as Promise from 'bluebird'

import config from '../common/config';
import { readMetadataOfImage } from './MetaData'

import walker from './lib/walker';
import matches from './lib/matches';

import Photo from '../common/models/Photo'
import Tag from '../common/models/Tag'
import { renderThumbnail } from './ForegroundClient'
import { bindMany } from '../common/util/LangUtil'
import { fetchPhotoWork, storeThumbnail } from './PhotoWorkStore'
import { profileScanner } from '../common/LogConstants'
import Profiler from '../common/util/Profiler'


const readFile = Promise.promisify(fs.readFile);

const allowed = new RegExp(config.acceptedRawFormats.join('$|') + '$', 'i');
const allowedImg = new RegExp(config.acceptedImgFormats.join('$|') + '$', 'i');

const extract = new RegExp(
    '([^\/]+)\.(' + config.acceptedRawFormats.join('|') + ')$',
    'i'
);

const extractImg = new RegExp(
    '([^\/]+)\.(' + config.acceptedImgFormats.join('|') + ')$',
    'i'
);

interface FileInfo {
    path: string
    imgPath?: string
    name: string
    isRaw: boolean
}

export default class Scanner {
    private progress: { processed: number, total: number, photosDir: string }

    constructor(private path: string, private versionsPath: string, private mainWindow: BrowserWindow) {
        this.progress = {
            processed: 0,
            total: 0,
            photosDir: path
        };

        bindMany(this, 'scanPictures', 'prepare', 'setTotal', 'onImportedStep', 'filterStoredPhoto', 'populateTags', 'walk')
    }

    prepare(filePaths: string[]): FileInfo[] {
        let rawFiles = filePaths.map(filePath =>
            filePath.match(allowed) ? filePath : null
        )
        .filter(filePath => filePath);

        let imgFiles = filePaths.map(filePath =>
            filePath.match(allowedImg) ? filePath : null
        )
        .filter(filePath => filePath);

        let preparedFiles = rawFiles.map(rawFile => {
            let filename = rawFile.match(extract)[1];
            let imgPos = matches(imgFiles, filename);

            let element: FileInfo = {
                path: rawFile,
                name: filename,
                isRaw: true
            };

            if (imgPos !== -1) {
                element.imgPath = imgFiles[imgPos];

                imgFiles = imgFiles.filter(imgFile =>
                    imgFile !== imgFiles[imgPos]
                );
            }

            return element;
        });

        imgFiles.forEach(imgFile => {
            let filename = imgFile.match(extractImg)[1];

            preparedFiles.push({
                path: imgFile,
                name: filename,
                isRaw: false
            });
        });

        return preparedFiles;
    }

    walk(file: FileInfo): Promise<void> {
        const overallProfiler = profileScanner ? new Profiler(`Importing ${file.path} (overall)`) : null

        const originalImgPath = file.path

        const metaDataProfiler = profileScanner ? new Profiler(`Importing ${file.path} (meta data)`) : null
        const readMetaData = readMetadataOfImage(originalImgPath)
            .then(result => {
                if (metaDataProfiler) {
                    metaDataProfiler.addPoint('Read meta data')
                    metaDataProfiler.logResult()
                }
                return result
            })

        const photoWorkProfiler = profileScanner ? new Profiler(`Importing ${file.path} (photo work)`) : null
        const readPhotoWork = fetchPhotoWork(originalImgPath)
            .then(result => {
                if (photoWorkProfiler) {
                    photoWorkProfiler.addPoint('Fetched photo work')
                    photoWorkProfiler.logResult()
                }
                return result
            })

        let overallPromise: Promise<any> = Promise.all([readMetaData, readPhotoWork])
            .then(results => {
                if (overallProfiler) overallProfiler.addPoint('Waited for meta data and PhotoWork')

                const [ metaData, photoWork ] = results
                return new Photo({ title: file.name })
                    .fetch()
                    .then(photo => {
                        if (overallProfiler) overallProfiler.addPoint('Fetched from DB')
                        return photo ? null : Photo.forge({
                            title: file.name,
                            extension: file.path.match(/\.(.+)$/i)[1],
                            orientation: metaData.orientation,
                            date: moment(metaData.createdAt).format('YYYY-MM-DD'),
                            flag: photoWork.flagged,
                            created_at: metaData.createdAt,
                            exposure_time: metaData.exposureTime,
                            iso: metaData.iso,
                            aperture: metaData.aperture,
                            focal_length: metaData.focalLength,
                            master: originalImgPath,
                            thumb_250: null,  // Never used. Thumbnails are created lazy by `src/ui/data/ImageProvider.ts`
                            thumb: null       // Will be set further down for raw images
                        })
                        .save()
                    })
                    .then(photo => {
                        if (overallProfiler) overallProfiler.addPoint('Stored to DB')
                        this.populateTags(photo, metaData.tags)
                        if (overallProfiler) overallProfiler.addPoint('Populated tags')
                        return photo
                    })
            })

        if (file.isRaw) {
            overallPromise = overallPromise
                .then(photo => {
                    const nonRawImgPath = file.isRaw ? `${config.thumbsPath}/${photo.id}.${config.workExt}` : null

                    let extractThumb
                    if (file.hasOwnProperty('imgPath')) {
                        extractThumb = Promise.resolve(file.imgPath)
                    } else {
                        extractThumb = libraw.extractThumb(
                            file.path,
                            `${config.tmp}/${file.name}`
                        )
                    }

                    return extractThumb
                        .then(imgPath => {
                            if (overallProfiler) overallProfiler.addPoint('Extracted non-raw image')
                            return readFile(imgPath)
                        })
                        .then(img => {
                            if (overallProfiler) overallProfiler.addPoint('Loaded extracted image')
                            return sharp(img)
                                .rotate()
                                .withMetadata()
                                .toFile(nonRawImgPath)
                        })
                        .then(() => {
                            if (overallProfiler) overallProfiler.addPoint('Rotated extracted image')
                            return photo
                                .save('thumb', nonRawImgPath, { patch: true })
                        })
                        .then(result => { if (overallProfiler) { overallProfiler.addPoint('Updated non-raw image path in DB') }; return result })
                })
        }
    
        return overallPromise
            .then(this.onImportedStep)
            .then(() => {
                if (overallProfiler) {
                    overallProfiler.addPoint('Updated import progress')
                    overallProfiler.logResult()
                }
            })
            .catch(err => {
                console.error('Importing photo failed', file, err)
            })
    }

    populateTags(photo, tags: string[]) {
        if (tags.length > 0) {
            return Promise.each(tags, tagName =>
                new Tag({ title: tagName })
                    .fetch()
                    .then(tag =>
                        tag ? tag : new Tag({ title: tagName }).save()
                    )
                    .then(tag => tag.photos().attach(photo))
            )
            .then(() => photo);
        }

        return photo;
    }
    onImportedStep() {
        this.progress.processed++;
        this.mainWindow.webContents.send('progress', this.progress);
        return true;
    }

    filterStoredPhoto(file) {
        return new Photo({ master: file.path })
            .fetch()
            .then(photo => !photo);
    }

    setTotal(files) {
        this.progress.total = files.length;
        return files;
    }

    scanPictures() {
        const profiler = profileScanner ? new Profiler('Overall scanning') : null
        return walker(this.path, [ this.versionsPath ])
            .then(result => { if (profiler) { profiler.addPoint('Scanned directories') }; return result })
            .then(this.prepare)
            .then(result => { if (profiler) { profiler.addPoint('Prepared files') }; return result })
            .filter(this.filterStoredPhoto)
            .then(result => { if (profiler) { profiler.addPoint('Filtered files') }; return result })
            .then(this.setTotal)
            .then(result => { if (profiler) { profiler.addPoint('Set total') }; return result })
            .map(this.walk, {
                concurrency: config.concurrency
            })
            .then(result => {
                if (profiler) {
                    profiler.addPoint(`Scanned ${this.progress.total} images`)
                    profiler.logResult()
                }
                return result
            })
      }
}
