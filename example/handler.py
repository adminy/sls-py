import requests


def hello(event, context):
    return requests.get('https://codeismagic.com/').json()
