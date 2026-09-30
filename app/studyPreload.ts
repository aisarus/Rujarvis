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
  openNote: (file: string) => call('openNote', file),
  audioUrl: (file: string) => call('audioUrl', file),
  onChanged: (listener: (preparing: string[]) => void) => {
    ipcRenderer.on(`${CHANNEL}:changed`, (_event, preparing: string[]) => listener(preparing));
  },
});
