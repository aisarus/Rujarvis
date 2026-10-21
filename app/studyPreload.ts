/**
 * Мост окна учёбы: страница видит только эти вызовы, без Node и файлов.
 */

import { contextBridge, ipcRenderer } from 'electron';

const CHANNEL = 'jarvis-study';

const call = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`${CHANNEL}:${name}`, ...args);

contextBridge.exposeInMainWorld('study', {
  today: () => call('today'),
  course: (name: string) => call('course', name),
  quizStart: (scope: { course: string; lecture?: string; topic?: string }) => call('quizStart', scope),
  quizAnswer: (id: string, index: number, chosen: number) => call('quizAnswer', id, index, chosen),
  openAnswer: (id: string, index: number, text: string) => call('openAnswer', id, index, text),
  examStart: (course: string, count: number, minutes: number) => call('examStart', course, count, minutes),
  examAnswer: (id: string, index: number, chosen: number) => call('examAnswer', id, index, chosen),
  examSubmit: (id: string) => call('examSubmit', id),
  cards: (course?: string) => call('cards', course ?? ''),
  cardReview: (course: string, id: string, verdict: 'again' | 'know') => call('cardReview', course, id, verdict),
  tasks: (course: string, lecture?: string) => call('tasks', course, lecture ?? ''),
  taskMark: (course: string, id: string, solved: boolean) => call('taskMark', course, id, solved),
  prepare: (notesFile: string) => call('prepare', notesFile),
  prepareAll: () => call('prepareAll'),
  setExam: (course: string, date: string) => call('setExam', course, date),
  setSchedule: (course: string, slots: Array<{ day: number; from: number; to: number }>) => call('setSchedule', course, slots),
  createCourse: (name: string, hebrew: string, code: string, language: string, notes: string) => call('createCourse', name, hebrew, code, language, notes),
  editCourse: (course: string, name: string, hebrew: string, code: string) => call('editCourse', course, name, hebrew, code),
  setCourseLanguages: (course: string, language: string, notes: string) => call('setCourseLanguages', course, language, notes),
  deleteCourse: (course: string) => call('deleteCourse', course),
  recordings: () => call('recordings'),
  deleteRecording: (notesFile: string) => call('deleteRecording', notesFile),
  deleteAllRecordings: () => call('deleteAllRecordings'),
  addCard: (id: string, index: number) => call('addCard', id, index),
  recording: (on: boolean) => call('recording', on),
  transcribe: (samples: Float32Array, sampleRate: number) => call('transcribe', samples, sampleRate),
  openNote: (file: string) => call('openNote', file),
  audioUrl: (file: string) => call('audioUrl', file),
  onLook: (listener: (look: string) => void) => {
    ipcRenderer.on('jarvis-look', (_event, look: string) => listener(look));
  },
  onChanged: (listener: (preparing: string[]) => void) => {
    ipcRenderer.on(`${CHANNEL}:changed`, (_event, preparing: string[]) => listener(preparing));
  },
});
